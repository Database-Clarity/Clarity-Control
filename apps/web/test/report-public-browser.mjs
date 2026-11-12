/* global document, window, innerWidth */
// Run after a production web build; all report API traffic is intercepted.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
const root = resolve('apps/web/dist');
const server = createServer((req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://a').pathname);
  if (!path.startsWith(root)) return res.end();
  let f = path;
  if (!existsSync(f) || extname(f) === '') f = resolve(root, 'index.html');
  const b = readFileSync(f);
  res.setHeader(
    'Content-Type',
    {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }[extname(f)] || 'application/octet-stream',
  );
  res.setHeader('Content-Encoding', 'gzip');
  res.end(gzipSync(b));
});
await new Promise((r) => server.listen(5261, '127.0.0.1', r));
const executablePath = [
  process.env.REPORT_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!executablePath) throw new Error('Set REPORT_BROWSER to a Chromium executable.');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    let options;
    window.turnstile = {
      render(_element, next) {
        options = next;
        return 'test';
      },
      execute() {
        options.callback('test-token');
      },
      reset() {},
      remove() {},
    };
  });
  await page.route(/\/me(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route(/\/reports(?:[/?]|$)/, (route) =>
    route.fulfill({
      status: route.request().method() === 'POST' ? 503 : 200,
      contentType: 'application/json',
      body:
        route.request().method() === 'POST'
          ? JSON.stringify({ error: 'Test service unavailable' })
          : '[]',
    }),
  );
  const requests = [];
  const bodyReads = [];
  page.on('response', (r) => {
    const read = (async () => {
      try {
        const b = await r.body();
        requests.push({
          url: r.url(),
          bytes: b.length,
          gzip: gzipSync(b).length,
          status: r.status(),
        });
      } catch {
        /* Aborted navigation responses need no body. */
      }
    })();
    bodyReads.push(read);
  });
  const cat = JSON.parse(
    readFileSync(
      root +
        '/assets/' +
        (await import('node:fs'))
          .readdirSync(root + '/assets')
          .find((f) => f.startsWith('report-catalog-0-')),
      'utf8',
    ),
  );
  const full = await (
    await fetch(
      'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/report-items.json',
    )
  ).json();
  const listing = (await import('node:fs')).readdirSync(root + '/assets');
  const owners = JSON.parse(
    readFileSync(
      root + '/assets/' + listing.find((f) => f.startsWith('report-catalog-64-')),
      'utf8',
    ),
  );
  const combined = {};
  for (let i = 0; i < 64; i++) {
    const shard = JSON.parse(
      readFileSync(
        root + '/assets/' + listing.find((f) => f.startsWith(`report-catalog-${i}-`)),
        'utf8',
      ),
    );
    if (shard.sourceCommit !== full.sourceCommit) throw new Error('Census source drift');
    Object.assign(combined, shard.items);
  }
  const assert = (await import('node:assert/strict')).default;
  assert.deepEqual(combined, full.items);
  for (const [hash, item] of Object.entries(full.items))
    assert.equal(owners[hash] ?? Number(hash), item.owner);
  writeFileSync(
    '.agents/reports-slim-census.json',
    JSON.stringify(
      {
        sourceCommit: full.sourceCommit,
        items: Object.keys(combined).length,
        aliases: Object.keys(owners).length,
        identities: 'exact equality for every producer item',
        ownerMappings: 'all equal',
      },
      null,
      2,
    ),
  );
  const hash = Object.keys(cat.items).find((h) => Number(h) > 3);
  await page.goto(`http://127.0.0.1:5261/#/report/${hash}?lang=en`);
  await page.locator('[data-line]').first().waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page
    .locator('img')
    .evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode().catch(() => {}))));
  await Promise.all(bodyReads);
  const wire = {
    hash,
    errors: [...errors],
    requests: [...requests],
    totalGzip: requests.reduce((n, r) => n + r.gzip, 0),
  };
  console.log(JSON.stringify(wire, null, 2));
  writeFileSync('.agents/reports-slim-wire.json', JSON.stringify(wire, null, 2));
  if (process.env.REPORT_BROWSER_WIRE_ONLY !== '1') {
    const matrix = [];
    for (const width of [390, 768, 1280])
      for (const theme of ['light', 'dark'])
        for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            ({ theme, scale }) =>
              localStorage.setItem(
                'clarity-settings:device:v1',
                JSON.stringify({ theme, uiScale: scale }),
              ),
            { theme, scale },
          );
          await page.reload();
          await page.locator('[data-line]').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          );
          const file = `.agents/slim-${width}-${theme}-${scale}.png`;
          await page.screenshot({ path: file, fullPage: true });
          matrix.push({ width, theme, scale, overflow, file });
        }
    // State transitions touched by entry/data loading: deep link, locale, account, picker, history, and unknown hash.
    await page.setViewportSize({ width: 1280, height: 900 });
    // Exercise compat's input, selection, restore, remark, and removal semantics on the compiled entry.
    await page.locator('[data-line]').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Note 1', exact: true }).fill('First renderer note.');
    await page.locator('[data-line]').filter({ hasText: /\S/ }).nth(1).click();
    await page.getByRole('textbox', { name: 'Note 2', exact: true }).fill('Second renderer note.');
    await page.reload();
    await page.locator('[data-line]').first().waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Note 1', exact: true }).inputValue(),
      'First renderer note.',
    );
    assert.equal(
      await page.getByRole('textbox', { name: 'Note 2', exact: true }).inputValue(),
      'Second renderer note.',
    );
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('de');
    await page.getByRole('button', { name: 'Mark again', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Mark again', exact: true }).first().click();
    await page.locator('[data-line]').first().click();
    assert.equal(
      await page.getByRole('textbox', { name: 'Note 1', exact: true }).inputValue(),
      'First renderer note.',
    );
    while (await page.getByRole('button', { name: 'Remove note', exact: true }).count())
      await page.getByRole('button', { name: 'Remove note', exact: true }).first().click();
    await page.getByRole('button', { name: '+ Whole tooltip', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Note 1', exact: true })
      .fill('Whole tooltip renderer note.');
    await page
      .getByRole('textbox', { name: /Video link/ })
      .first()
      .fill('https://discord.com/example');
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    await page.getByText(/Discord links expire/).waitFor();
    await page
      .getByRole('textbox', { name: /Video link/ })
      .first()
      .fill('https://youtu.be/example');
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    await page
      .getByText(/unavailable/)
      .first()
      .waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Note 1', exact: true }).inputValue(),
      'Whole tooltip renderer note.',
    );
    await page.getByRole('button', { name: 'Remove note', exact: true }).click();
    await page
      .getByRole('textbox', { name: /Video link/ })
      .first()
      .fill('');

    await page.getByRole('button', { name: /Account:/ }).click();
    await page.getByRole('dialog', { name: 'Account' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Change', exact: true }).click();
    await page.getByRole('combobox').first().waitFor();
    await page.goBack();
    await page.locator('[data-line]').first().waitFor();
    await page.goForward();
    await page.getByRole('combobox').first().waitFor();
    await page.goto('http://127.0.0.1:5261/#/report/4294967295');
    await page
      .getByText(/has no Clarity tooltip to report/i)
      .first()
      .waitFor({ timeout: 10000 });
    writeFileSync('.agents/reports-slim-matrix.json', JSON.stringify({ matrix, errors }, null, 2));
    if (matrix.some((x) => x.overflow) || errors.length) throw new Error('Render QA failed');
  }
  await context.close();
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
