/* global document, window, getComputedStyle, location */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The real shell (header, notices, left column, divider, status line) on synthetic data, both
// themes, at the widths the design names. Asserts what must hold (no horizontal overflow, editor
// text never moving when a notice or popover appears, no clipped or wrapping controls) and
// writes screenshots to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-s4-shots');
await mkdir(shots, { recursive: true });
const port = 5290;
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

const setup = (page, calls) =>
  page.evaluate((list) => {
    for (const [name, ...args] of list) window.shellFixture[name](...args);
  }, calls);
const editorTop = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('.cm-line');
    const rect = line?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), left: Math.round(rect.left) } : null;
  });
const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('[hidden]');
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};
/** Controls whose text is cut off or wraps inside a fixed-height control. */
const clipped = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'header button, header a, header input, [data-editor-status] button, [data-notice-strip] button',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible')
          return false; // an intentional ellipsis
        const lines = el.getClientRects().length;
        return r.height > 40 && lines > 0 && el.tagName === 'BUTTON' && r.height > 2 * 18 + 8;
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
  );

async function open(theme, viewport, { phone = false, coarse = false } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone || coarse,
    isMobile: phone,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.locator('.cm-content').waitFor();
  await setup(page, [['role', 'maintainer']]);
  return { context, page, errors };
}

/** WCAG contrast of the preview's text on its own surface; returns the worst pair. */
const previewContrast = (page) =>
  page.evaluate(() => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const parse = (css) =>
      css
        .match(/[\d.]+/g)
        .slice(0, 4)
        .map(Number);
    const luminance = ([r, g, b]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const surface = document.querySelector('[class*="_preview_"]');
    if (!surface) return null;
    const back = parse(getComputedStyle(surface).backgroundColor);
    const worst = [];
    for (const element of surface.querySelectorAll('span, a, div')) {
      if (![...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (element.closest('[class*="_header_"]')) continue;
      const [r, g, b, alpha = 1] = parse(getComputedStyle(element).color);
      const mixed = [r, g, b].map((c, i) => c * alpha + back[i] * (1 - alpha));
      const [l1, l2] = [luminance(mixed), luminance(back)].sort((x, y) => y - x);
      worst.push({
        text: element.textContent.trim().slice(0, 12),
        ratio: (l1 + 0.05) / (l2 + 0.05),
      });
    }
    return worst.sort((x, y) => x.ratio - y.ratio)[0] ?? null;
  });

/** Types at the end of the editor text: a real edit through the real editor. */
async function typeInEditor(page, text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
const columnHidden = (page) =>
  page.evaluate(() => document.getElementById('shell-left')?.hasAttribute('hidden') ?? true);

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    // The editor at the widths the design names, and the 700/701 boundary.
    for (const width of [1440, 1366, 1280, 1099, 768, 701]) {
      const { context, page, errors } = await open(theme, { width, height: 800 });
      await setup(page, [['drafts', 2]]);
      await noOverflow(page, `editor ${width}`);
      assert.deepEqual(await clipped(page), [], `${width}: controls clip or wrap their text`);
      const hidden = await columnHidden(page);
      assert.equal(hidden, width < 1100, `${width}: column is collapsed only in compact windows`);
      if (!hidden) {
        const left = await page.locator('#shell-left').boundingBox();
        assert.ok(left.width >= 280 && left.width <= 480, `${width}: column width ${left.width}`);
        const main = await page.locator('#main-content').boundingBox();
        assert.ok(main.width >= 480, `${width}: page keeps 480 (${main.width})`);
        // Two independent scrollers: the window itself does not scroll.
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
          true,
          `${width}: the window does not scroll`,
        );
      }
      await page.screenshot({ path: out(`editor-${width}`) });
      if (hidden) {
        // Compact: opening the column pushes the page, so the editor is never covered.
        await page.locator('button[aria-controls="shell-left"]').click();
        const left = await page.locator('#shell-left').boundingBox();
        const editor = await page.locator('.cm-content').boundingBox();
        assert.ok(
          editor.x >= left.x + left.width - 1,
          `${width}: the open column does not cover the editor`,
        );
        await noOverflow(page, `editor ${width} open`);
        await page.screenshot({ path: out(`editor-${width}-open`) });
      }
      assert.deepEqual(errors, [], 'no page errors');
      await context.close();
    }

    // The preview's own colours hold 4.5:1 on its surface in this theme.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 });
      const worst = await previewContrast(page);
      assert.ok(worst && worst.ratio >= 4.5, `${theme}: preview contrast ${JSON.stringify(worst)}`);
      await context.close();
    }

    // Symbols: one box size everywhere; the light theme swaps white glyphs for outlined, filled copies.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 });
      const symbols = await page.evaluate(() =>
        [...document.querySelectorAll('[class*="_preview_"] span, [class*="_preview_"] div')]
          .map((el) => {
            const style = getComputedStyle(el, '::before');
            const name =
              /_(kinetic|arc|solar|void|stasis|strand|primary|special|heavy|barrier|overload|unstoppable|hunter|titan|warlock)_/.exec(
                el.className,
              )?.[1];
            return name
              ? { name, width: style.width, height: style.height, image: style.backgroundImage }
              : null;
          })
          .filter(Boolean),
      );
      assert.ok(symbols.length >= 14, `symbols rendered (${symbols.length})`);
      assert.deepEqual(
        [...new Set(symbols.map((s) => `${s.width}x${s.height}`))],
        ['12px x 12px'.replace(' x ', 'x')],
        'every symbol has the same width and height',
      );
      for (const symbol of symbols.filter((s) =>
        ['kinetic', 'primary', 'barrier', 'overload', 'unstoppable'].includes(s.name),
      ))
        assert.equal(
          symbol.image.includes('/assets/light/') || symbol.image.includes('light'),
          theme === 'light',
          `${symbol.name} uses the outlined copy only in the light theme`,
        );
      await page
        .locator('#shell-left [class*="_preview_"]')
        .screenshot({ path: out('preview-symbols') });
      await context.close();
    }

    // Notices: overlays under the header; the editor text never moves.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 });
      const before = await editorTop(page);
      const mainBefore = await page.locator('#main-content').boundingBox();
      await setup(page, [['notice', 'all']]);
      await page.locator('[data-notice-strip]').waitFor();
      assert.deepEqual(await editorTop(page), before, 'a notice never moves the editor text');
      assert.deepEqual(
        await page.locator('#main-content').boundingBox(),
        mainBefore,
        'nor the page',
      );
      const header = await page.locator('header').first().boundingBox();
      const strip = await page.locator('[data-notice-strip]').boundingBox();
      assert.ok(strip.y >= header.y + header.height, 'the strip starts under the header');
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.querySelector('[data-notice-strip]')).position,
        ),
        'absolute',
      );
      const order = await page
        .locator('[data-notice-strip] > div')
        .evaluateAll((els) => els.map((el) => el.dataset.level));
      assert.deepEqual(order, ['alert', 'warning', 'status'], 'alert > warning > status');
      assert.deepEqual(await clipped(page), [], 'notice buttons do not wrap');
      await page.screenshot({ path: out('notices') });
      await setup(page, [['notice', 'long']]);
      await page.screenshot({
        path: out('notice-long'),
        clip: { x: 0, y: 0, width: 1280, height: 220 },
      });
      assert.deepEqual(await editorTop(page), before);
      await noOverflow(page, 'notices');
      await context.close();
    }

    // The preview column: collapse, the unreviewed marker, the guard, expand, Alt+P.
    {
      const { context, page } = await open(theme, { width: 1366, height: 800 });
      const toggle = page.locator('button[aria-controls="shell-left"]');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await toggle.click();
      assert.equal(await columnHidden(page), true);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.screenshot({ path: out('collapsed') });
      await typeInEditor(page, ' more');
      await page.locator('[data-editor-status] [data-attention]').waitFor();
      assert.match(await page.locator('[data-editor-status]').innerText(), /1 not previewed/);
      assert.match(await toggle.getAttribute('aria-label'), /1 change not reviewed/);
      await page.screenshot({ path: out('collapsed-unreviewed') });

      // Leaving is refused; Show preview expands, focuses the column and stays.
      const hash = await page.evaluate(() => location.hash);
      const combobox = page.getByRole('combobox', { name: 'Tooltip' });
      await combobox.click();
      await page.getByRole('option', { name: /Forerunner/ }).click();
      const dialog = page.locator('dialog[open]');
      await dialog.waitFor();
      assert.equal(await page.evaluate(() => location.hash), hash, 'the route did not change');
      await page.screenshot({ path: out('collapse-guard') });
      await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await columnHidden(page), false, 'Show preview expands the column');
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'shell-left',
        'and moves focus into it',
      );
      assert.equal(await page.evaluate(() => location.hash), hash, 'and stays on the item');
      await page.locator('[data-editor-status] [data-attention]').waitFor({ state: 'detached' });
      // The preview has been shown with the current text: leaving works now.
      await combobox.click();
      await page.getByRole('option', { name: /Forerunner/ }).click();
      await page.waitForFunction((h) => location.hash !== h, hash);
      assert.equal(await page.locator('dialog[open]').count(), 0);

      // Alt+P toggles.
      await page.locator('body').click({ position: { x: 700, y: 400 } });
      await page.keyboard.press('Alt+p');
      assert.equal(await columnHidden(page), true, 'Alt+P collapses');
      await page.keyboard.press('Alt+p');
      assert.equal(await columnHidden(page), false, 'Alt+P expands');
      await context.close();
    }

    // Dragging the divider resizes the column and the saved size survives a reload.
    {
      const { context, page } = await open(theme, { width: 1440, height: 800 });
      const handle = page.locator('[role="separator"][aria-label="Resize preview column"]');
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + 8, box.y + 300);
      await page.mouse.down();
      await page.mouse.move(box.x + 8 + 100, box.y + 300, { steps: 6 });
      await page.mouse.up();
      const widened = (await page.locator('#shell-left').boundingBox()).width;
      assert.ok(Math.abs(widened - 436) <= 2, `dragged to 436 (${widened})`);
      await page.screenshot({ path: out('divider-dragged') });
      await page.reload();
      await page.locator('.cm-content').waitFor();
      assert.ok(
        Math.abs((await page.locator('#shell-left').boundingBox()).width - widened) <= 2,
        'the width is remembered',
      );
      await context.close();
    }

    // Compendium and Review keep a list column that resizes the same way.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 });
      await page.evaluate(() => (location.hash = '#/compendium'));
      await page.locator('aside[aria-label="Context"]').waitFor();
      await noOverflow(page, 'compendium');
      await page.screenshot({ path: out('compendium-list') });
      await page.evaluate(() => (location.hash = '#/review'));
      await page.locator('aside[aria-label="Context"]').waitFor();
      await page.screenshot({ path: out('review-list') });
      await context.close();
    }

    // Phone: no column, no dividers; the preview is a view of the page.
    {
      const { context, page } = await open(theme, { width: 390, height: 844 }, { phone: true });
      assert.equal(await page.locator('#shell-left').count(), 0, 'no column on a phone');
      assert.equal(await page.locator('[role="separator"]').count(), 0, 'no dividers on a phone');
      await noOverflow(page, 'phone editor');
      await setup(page, [['notice', 'all']]);
      await page.locator('[data-notice-strip]').waitFor();
      for (const button of await page.locator('[data-notice-strip] button').all()) {
        const box = await button.boundingBox();
        assert.ok(box.height >= 44, `phone notice target ${box.width}x${box.height}`);
      }
      await noOverflow(page, 'phone notices');
      await page.screenshot({ path: out('phone-notices') });
      await setup(page, [['notice', 'none']]);
      await page.getByRole('tab', { name: 'Preview' }).click();
      await page.screenshot({ path: out('phone-preview') });
      await context.close();
    }
  }
  console.log('Layout grid, notices, preview column, guard and screenshots passed.');
} finally {
  await browser.close();
  await server.close();
}
