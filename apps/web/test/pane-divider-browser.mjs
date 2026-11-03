/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Captures the shared pane divider (rest, hover, keyboard focus, drag, clamp, reset) and the
// preview leave prompt in both themes from synthetic data, and checks that nothing around the
// divider moves. Output directory: argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-s2-shots');
await mkdir(shots, { recursive: true });

const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port: 5288, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const url = 'http://127.0.0.1:5288/test/pane-divider.html';

const luminance = ([r, g, b]) => {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const rgb = (css) =>
  css
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);

const rects = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-pane]')].map((element) => {
        const r = element.getBoundingClientRect();
        return [element.dataset.pane, [r.x, r.y, r.width, r.height].map(Math.round)];
      }),
    ),
  );
const valueOf = (page, name) =>
  page.getByRole('separator', { name }).getAttribute('aria-valuenow').then(Number);
const savedPanes = (page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('clarity-settings:device:v1') ?? '{}').panes ?? {},
  );

try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 520 },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole('separator', { name: 'Resize left column' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    const left = page.getByRole('separator', { name: 'Resize left column' });
    const right = page.getByRole('separator', { name: 'Resize editor and Compendium' });

    // Rest: a 16px hit zone with a 1px line and a 3px pill, defaults 336 / 384.
    assert.equal(await valueOf(page, 'Resize left column'), 336);
    assert.equal(await valueOf(page, 'Resize editor and Compendium'), 384);
    const metrics = await left.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const line = getComputedStyle(element, '::before');
      const pill = getComputedStyle(element, '::after');
      return {
        width: box.width,
        line: line.width,
        pill: pill.width,
        pillColor: pill.backgroundColor,
        cursor: getComputedStyle(element).cursor,
      };
    });
    assert.equal(metrics.width, 16);
    assert.equal(metrics.line, '1px');
    assert.equal(metrics.pill, '3px');
    assert.equal(metrics.cursor, 'col-resize');
    // The pill is a control boundary: 3:1 against both panes it sits between.
    const surfaces = await page.evaluate(() => {
      const style = (selector) =>
        getComputedStyle(document.querySelector(selector)).backgroundColor;
      return {
        col: style('[data-pane="left"]'),
        editor: style('[data-pane="editor"]'),
        page: style('[data-testid="bench"]'),
      };
    });
    for (const [name, back] of Object.entries(surfaces)) {
      const r = ratio(rgb(metrics.pillColor), rgb(back));
      console.log(`${theme} pill on ${name}: ${r.toFixed(2)}`);
      assert.ok(r >= 3, `${theme} pill on ${name} contrast ${r}`);
    }
    await page.screenshot({ path: `${shots}/${theme}-divider-rest.png` });

    // Hover and keyboard focus restyle only the divider; no pane moves.
    const before = await rects(page);
    await left.hover();
    assert.deepEqual(await rects(page), before);
    await page.screenshot({ path: `${shots}/${theme}-divider-hover.png` });
    await page.mouse.move(5, 5);
    await page.keyboard.press('Tab');
    assert.equal(await left.evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(await rects(page), before);
    await page.keyboard.press('ArrowRight');
    assert.equal(await valueOf(page, 'Resize left column'), 344);
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await valueOf(page, 'Resize left column'), 376);
    // Only the divider's neighbours change width, by exactly what moved.
    const moved = await rects(page);
    assert.equal(moved.left[2], 376);
    assert.equal(moved.editor[0], before.editor[0] + 40);
    assert.equal(moved.main[1], before.main[1], 'nothing shifts vertically');
    await page.screenshot({ path: `${shots}/${theme}-divider-focus.png` });
    await page.keyboard.press('Home');
    assert.equal(await left.getAttribute('aria-valuenow'), '0');
    assert.equal(await left.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('End');
    assert.equal(await valueOf(page, 'Resize left column'), 376);

    // Drag: follows the pointer, saves on release, restored on reload before first paint.
    const box = await right.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy, { steps: 6 });
    assert.equal(await valueOf(page, 'Resize editor and Compendium'), 444);
    assert.equal(await right.getAttribute('data-dragging'), 'true');
    assert.equal((await savedPanes(page))['editor:right'], undefined, 'nothing saved mid-drag');
    await page.screenshot({ path: `${shots}/${theme}-divider-drag.png` });
    await page.mouse.up();
    assert.equal((await savedPanes(page))['editor:right'].width, 444);
    await page.reload();
    await page.getByRole('separator', { name: 'Resize left column' }).waitFor();
    assert.equal(await valueOf(page, 'Resize editor and Compendium'), 444);

    // Clamp: a narrower window shows less but keeps what was chosen; the editor keeps 480.
    await page.setViewportSize({ width: 1000, height: 520 });
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[aria-label="Resize editor and Compendium"]')
            ?.getAttribute('aria-valuenow'),
        ) < 444,
    );
    const narrow = await rects(page);
    assert.ok(narrow.editor[2] >= 480, `editor stays at least 480, got ${narrow.editor[2]}`);
    assert.ok(
      (await valueOf(page, 'Resize editor and Compendium')) < 444,
      'the right pane gives way',
    );
    const kept = await savedPanes(page);
    assert.equal(kept['editor:right'].width, 444, 'the chosen width is not overwritten');
    await page.screenshot({ path: `${shots}/${theme}-divider-clamp.png` });
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Resize editor and Compendium"]')
          ?.getAttribute('aria-valuenow') === '444',
    );

    // Double click resets that pair only.
    await right.dblclick();
    assert.equal(await valueOf(page, 'Resize editor and Compendium'), 384);
    assert.equal((await savedPanes(page))['editor:right'], undefined);
    await context.close();

    // The preview leave prompt, over a real data router.
    const guardContext = await browser.newContext({
      viewport: { width: 900, height: 520 },
      colorScheme: theme,
    });
    const guard = await guardContext.newPage();
    await guard.goto(`${url}?scene=guard`);
    await guard.getByRole('link', { name: 'Review changes' }).click();
    const dialog = guard.getByRole('dialog', { name: 'Check the preview first' });
    await dialog.waitFor();
    assert.equal(
      await guard.evaluate(() => document.activeElement?.textContent),
      'Show previewEnter',
      'Enter activates Show preview',
    );
    assert.deepEqual(
      await dialog.locator('footer button').allTextContents(),
      ['Show previewEnter', 'StayEsc'],
      'no bypass',
    );
    await guard.screenshot({ path: `${shots}/${theme}-guard-prompt.png` });
    await guard.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.match(await guard.evaluate(() => document.body.textContent), /Editing Demolitionist/);
    await guard.getByRole('link', { name: 'Review changes' }).click();
    await dialog.waitFor();
    await guard.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    assert.match(await guard.evaluate(() => document.body.textContent), /Editing Demolitionist/);
    await guardContext.close();
  }
  console.log('Pane divider and leave prompt screenshots and checks passed.');
} finally {
  await browser.close();
  await server.close();
}
