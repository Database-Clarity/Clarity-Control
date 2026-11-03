/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Overhaul P2 step 9 in the real shell on synthetic data: icon and colour tags drawn as fixed-width
// symbols, the hover/selection popover, the raw toggle (Ctrl+Shift+.) and the caret-reveal setting.
// Both themes at 390 / 768 / 1280 (+ the smallest and largest interface scale once): zero horizontal
// overflow, one width for every symbol, and hover/popover never move a line of text.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s9-shots');
await mkdir(shots, { recursive: true });
const port = 5299;
const url = `http://127.0.0.1:${port}/test/shell.html`;

process.env.VITE_API_URL = 'https://api.fixture.invalid';
const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const lineTops = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')].map((line) => {
      const box = line.getBoundingClientRect();
      return [Math.round(box.top * 10) / 10, Math.round(box.height * 10) / 10];
    }),
  );
const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.right > window.innerWidth + 1 &&
          !el.closest('[hidden]') &&
          !el.closest('.cm-scroller') &&
          !el.closest('[data-markup-row] [role=toolbar]')
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};

const sample =
  '<kinetic/><arc/><solar/><void/><stasis/><strand/><heavy/><primary/><special/><barrier/><overload/><unstoppable/> icons\n<yellow 10% /> <blue reload /> <green damage /> <purple void <arc/> /> <pve 5 /> <pvp [3] /> <bold b />\n';
async function open(theme, viewport, phone, scale) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (scale)
    await context.addInitScript((value) => {
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
    }, scale);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate(() => {
    window.shellFixture.role('maintainer');
    window.shellFixture.variants();
    window.shellFixture.kinetic();
  });
  await page.evaluate(() => {
    window.location.hash = '#/t/1000?lang=en';
  });
  await page.locator('.cm-content').first().waitFor();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText(sample);
  await page.locator('.cm-symbol-icon').first().waitFor();
  return { context, page, errors };
}

async function check(theme, width, height, phone, scale, name) {
  const label = `${theme} ${width}${scale ? ` @${scale}%` : ''}`;
  const { context, page, errors } = await open(theme, { width, height }, phone, scale);
  const widgets = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-symbol')].map((el) => ({
      width: Math.round(el.getBoundingClientRect().width * 10) / 10,
      kind: el.className,
      markup: el.dataset.symbol,
    })),
  );
  assert.ok(widgets.length >= 25, `${label}: symbols drawn (${widgets.length})`);
  assert.ok(
    widgets.every((widget) => Math.abs(widget.width - widgets[0].width) <= 0.5),
    `${label}: one width for every symbol ${JSON.stringify([...new Set(widgets.map((w) => w.width))])}`,
  );
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-symbol-icon')].map(
      (el) => getComputedStyle(el, '::before').backgroundImage !== 'none',
    ),
  );
  assert.ok(drawn.length > 0 && drawn.every(Boolean), `${label}: icons draw the preview artwork`);
  assert.equal(
    await page.evaluate(() => document.querySelector('.cm-content').textContent.includes('<arc/>')),
    false,
    `${label}: raw tag text is not shown`,
  );
  await noOverflow(page, `${label} widgets`);
  await page.screenshot({ path: `${shots}/${name}-widgets.png` });

  const before = await lineTops(page);
  if (!phone) {
    // Hover: a popover with the markup, no line moves.
    await page.locator('.cm-symbol').nth(2).hover();
    await page.locator('.cm-symbol-popover').waitFor();
    assert.ok(
      (await page.locator('.cm-symbol-popover code').textContent()).startsWith('<'),
      `${label}: hover popover shows the markup`,
    );
    assert.deepEqual(await lineTops(page), before, `${label}: hover moved text`);
    await page.screenshot({ path: `${shots}/${name}-hover.png` });
    await page.mouse.move(2, 2);
    await page.locator('.cm-symbol-popover').waitFor({ state: 'detached' });
  }

  // Click selects the symbol: popover with the hint, Enter edits, Esc cancels. Nothing moves.
  await page.locator('.cm-symbol').nth(1).click();
  await page.locator('.cm-symbol-popover').waitFor();
  assert.deepEqual(await lineTops(page), before, `${label}: selecting a symbol moved text`);
  await page.keyboard.press('Enter');
  await page.locator('.cm-symbol-input').waitFor();
  assert.deepEqual(await lineTops(page), before, `${label}: the edit popover moved text`);
  await page.screenshot({ path: `${shots}/${name}-edit.png` });
  await page.keyboard.press('Escape');
  await page.locator('.cm-symbol-input').waitFor({ state: 'detached' });
  assert.equal(
    await page.locator('.cm-symbol').count(),
    widgets.length,
    `${label}: Esc keeps the symbols`,
  );

  // Raw toggle: the markup shows, toggling back restores the exact layout.
  await page.locator('.cm-content').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+Shift+.');
  assert.equal(await page.locator('.cm-symbol').count(), 0, `${label}: raw view has no widgets`);
  assert.ok(
    await page.evaluate(() => document.querySelector('.cm-content').textContent.includes('<arc/>')),
    `${label}: raw view shows the markup`,
  );
  await noOverflow(page, `${label} raw`);
  await page.screenshot({ path: `${shots}/${name}-raw.png` });
  await page.keyboard.press('Control+Shift+.');
  assert.equal(
    await page.locator('.cm-symbol').count(),
    widgets.length,
    `${label}: back to symbols`,
  );
  assert.deepEqual(await lineTops(page), before, `${label}: toggling back changed the layout`);

  assert.deepEqual(errors, [], `${label}: page errors`);
  await context.close();
}

try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      await check(theme, width, height, phone, 0, `${theme}-${width}`);
    }
    await check(theme, 1280, 800, false, 85, `${theme}-1280-scale85`);
    await check(theme, 1280, 800, false, 150, `${theme}-1280-scale150`);
  }

  // Caret reveal (device setting): the raw tag shows only where the caret is.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ symbolReveal: 'caret' }));
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('header').first().waitFor();
    await page.evaluate(() => {
      window.shellFixture.role('maintainer');
      window.shellFixture.variants();
      window.shellFixture.kinetic();
      window.location.hash = '#/t/1000?lang=en';
    });
    await page.locator('.cm-symbol').first().waitFor();
    const total = await page.locator('.cm-symbol').count();
    await page.locator('.cm-symbol').first().click();
    assert.ok(
      (await page.locator('.cm-symbol').count()) < total,
      'caret mode reveals the symbol under the caret',
    );
    assert.equal(await page.locator('.cm-symbol-popover').count(), 0, 'caret mode has no popover');
    await page.screenshot({ path: `${shots}/caret-reveal.png` });
    await context.close();
  }
  console.log('symbols browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
