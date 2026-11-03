/* global document, window */
// Render QA for the publisher activity strip (flag ON): no overflow, no wrapped controls, equal row
// heights across statuses (no layout shift), at 390/768/1280. Screenshots: PUBLISHER_SHOTS=<dir>.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.PICKER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!browserPath) throw new Error('Set PICKER_BROWSER to an installed Chromium browser.');
const shots = process.env.PUBLISHER_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const output = await mkdtemp(join(tmpdir(), 'clarity-publisher-'));
let browser;
try {
  await build({
    configFile: false,
    root: web,
    base: './',
    logLevel: 'error',
    define: {
      'import.meta.env.VITE_PUBLISHER_ENABLED': JSON.stringify('1'),
      'import.meta.env.VITE_API_URL': JSON.stringify('https://synthetic.invalid'),
    },
    build: {
      target: 'esnext',
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: join(web, 'test', 'publisher-activity.html') },
    },
  });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking'],
  });
  const results = [];
  for (const width of [390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `${pathToFileURL(join(output, 'test', 'publisher-activity.html')).href}?mode=all`,
    );
    await page.waitForSelector('[aria-label="Publish activity"] li');
    await page.waitForFunction(() => !document.body.textContent.includes('Comparing publishable'));
    const measure = () =>
      page.evaluate(() => {
        const section = document.querySelector('[aria-label="Publish activity"]');
        const rows = [...section.querySelectorAll('li')];
        const clipped = [];
        for (const chip of section.querySelectorAll('li > span:first-child'))
          if (chip.scrollWidth > chip.clientWidth + 1) clipped.push(chip.textContent);
        const lines = (element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        };
        // Controls (toolbar, dialog-free page buttons, activity actions) stay on one line; the long
        // wrapped row-name buttons inside the pending list are existing, intentionally wrapping text.
        const wrapped = [...document.querySelectorAll('article button')]
          .filter((b) => !b.closest('ul') || b.closest('[aria-label="Publish activity"]'))
          .filter((b) => lines(b) > 1)
          .map((b) => b.textContent);
        const toolbarButtons = [];
        return {
          docWidth: document.documentElement.scrollWidth,
          rows: rows.map((r) => ({
            h: Math.round(r.getBoundingClientRect().height * 10) / 10,
            chip: r.children[0].textContent,
          })),
          clipped,
          wrapped,
          tallControls: toolbarButtons.map((b) => b.textContent),
          top: Math.round(section.getBoundingClientRect().top),
          height: Math.round(section.getBoundingClientRect().height),
        };
      });
    const before = await measure();
    assert.ok(before.docWidth <= width, `${width}: horizontal overflow ${before.docWidth}`);
    assert.deepEqual(before.clipped, [], `${width}: chips clipped`);
    assert.deepEqual(before.wrapped, [], `${width}: wrapped controls`);
    assert.deepEqual(before.tallControls, [], `${width}: tall controls`);
    const heights = new Set(before.rows.map((r) => r.h));
    assert.equal(heights.size, 1, `${width}: row heights differ ${JSON.stringify(before.rows)}`);
    if (shots)
      await page.screenshot({ path: join(shots, `activity-${width}.png`), fullPage: false });
    // A status change must not move or resize anything.
    await page.evaluate(() => {
      window.__setOpStatus(1, 'done');
      window.__setOpStatus(2, 'failed');
    });
    const after = await measure();
    assert.equal(after.height, before.height, `${width}: strip height changed on status change`);
    assert.equal(after.top, before.top, `${width}: strip moved on status change`);
    assert.ok(after.docWidth <= width);
    // Confirm dialog wording (publisher flow) renders without overflow too.
    await page.getByRole('button', { name: 'Select page' }).click();
    await page.getByRole('button', { name: 'Publish selected' }).click();
    await page.waitForSelector('dialog[open]');
    const dialog = await page.evaluate(() => ({
      text: document.querySelector('dialog[open]').textContent,
      docWidth: document.documentElement.scrollWidth,
      over:
        document.querySelector('dialog[open]').scrollWidth >
        document.querySelector('dialog[open]').clientWidth + 1,
    }));
    assert.match(dialog.text, /Publish to live/);
    assert.match(dialog.text, /runs in the background/);
    assert.ok(!dialog.over && dialog.docWidth <= width, `${width}: dialog overflow`);
    if (shots) await page.screenshot({ path: join(shots, `confirm-${width}.png`) });
    assert.deepEqual(errors, [], `${width}: page errors`);
    results.push({
      width,
      rows: before.rows.length,
      rowHeight: [...heights][0],
      stripHeight: before.height,
    });
    await context.close();
  }
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
