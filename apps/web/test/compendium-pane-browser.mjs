/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The Compendium / English right pane (overhaul P2 step 5) in the real shell on synthetic data:
// both themes, 1440 / 1280 / 1024 / 800 / 768 / 390. One 28px pane header (44px on touch), a body
// that scrolls on its own, the Changes / Before-After switch in the header when the pane is wide
// and above the diff when it is narrow, the device zoom (70-100 %), no horizontal overflow, no
// clipped or wrapping controls, and editor text that never moves for any of it.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s5-shots');
await mkdir(shots, { recursive: true });
const port = 5295;
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

const firstLine = (page) =>
  page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((el) => el.offsetParent);
    const rect = line?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), left: Math.round(rect.left) } : null;
  });
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
          !el.closest('.cm-scroller')
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};
/** The pane header's controls: nothing clips its own text, nothing wraps, header stays one line. */
const clipped = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-label="Compendium tools"] *, [aria-label="English tools"] *',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const style = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && style.overflow !== 'visible') return true;
        if (el.tagName === 'SELECT') return false;
        const line = parseFloat(style.lineHeight) || 16;
        return ['BUTTON', 'H3', 'OUTPUT', 'LABEL'].includes(el.tagName) && r.height > Math.max(2 * line + 8, 50);
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
  );
const headerHeight = (page, label) =>
  page.evaluate(
    (name) =>
      Math.round(
        document.querySelector(`[aria-label="${name} tools"]`).getBoundingClientRect().height,
      ),
    label,
  );

async function open(
  theme,
  viewport,
  path,
  { phone = false, role = 'maintainer', rightWidth } = {},
) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (rightWidth)
    await context.addInitScript((width) => {
      localStorage.setItem(
        'clarity-settings:device:v1',
        JSON.stringify({ panes: { 'editor:right': { width, collapsed: false } } }),
      );
    }, rightWidth);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate((who) => {
    window.shellFixture.role(who);
    window.shellFixture.variants();
    window.shellFixture.compendiumRows();
    window.shellFixture.outdatedTranslation();
  }, role);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${path}`);
  await page.locator('.cm-content').first().waitFor();
  await page.waitForTimeout(300); // the pane measures itself after layout
  return { context, page, errors };
}

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    // Desktop widths, default pane width: the diff switch sits above the diff.
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 800],
    ]) {
      const { context, page, errors } = await open(theme, { width, height }, '/t/1001?lang=en');
      const label = `${theme} ${width}`;
      const header = page.locator('[aria-label="Compendium tools"]');
      await header.waitFor();
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${label}: pane header is 28px`);
      assert.deepEqual(await clipped(page), [], `${label}: header controls clip or wrap`);
      await noOverflow(page, label);
      assert.equal(await header.locator('h3').textContent(), 'Compendium');
      assert.ok(await header.getByRole('button', { name: 'Pick other row' }).isVisible());
      assert.equal(
        await header.locator('[aria-label="Compendium diff view"]').count(),
        0,
        `${label}: a narrow pane keeps the diff switch out of the header`,
      );
      assert.equal(await page.locator('[aria-label="Compendium diff view"]').count(), 1);
      await page.screenshot({ path: out(`compendium-${width}`) });

      // Zoom and the diff view change the pane only: the editor text stays where it is.
      const text = await firstLine(page);
      const zoomed = page.locator('aside[aria-label^="Compendium for"] [data-scale]');
      const before = await zoomed.boundingBox();
      for (let i = 0; i < 3; i++) await header.getByRole('button', { name: 'Smaller' }).click();
      assert.equal(await header.locator('output').textContent(), '70%');
      assert.ok(await header.getByRole('button', { name: 'Smaller' }).isDisabled());
      const after = await zoomed.boundingBox();
      assert.ok(after.height < before.height, `${label}: zoom 70% shrinks the pane body`);
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${label}: header never scales`);
      await page.getByRole('button', { name: 'Before / After' }).click();
      assert.deepEqual(await firstLine(page), text, `${label}: pane controls moved the text`);
      await noOverflow(page, `${label} zoomed before/after`);
      assert.deepEqual(await clipped(page), [], `${label} zoomed: header clips`);
      await page.screenshot({ path: out(`compendium-${width}-zoom70-before-after`) });

      // The body scrolls on its own: the header and the editor stay put.
      for (let i = 0; i < 3; i++) await header.getByRole('button', { name: 'Larger' }).click();
      await page.getByRole('button', { name: 'Changes' }).click();
      const headerTop = await header.evaluate((el) => Math.round(el.getBoundingClientRect().top));
      const scrolled = await page.evaluate(() => {
        const pane = document.querySelector('aside[aria-label^="Compendium for"]');
        const scroller = pane.lastElementChild;
        scroller.scrollTop = 9999;
        return { top: scroller.scrollTop, fits: scroller.scrollHeight > scroller.clientHeight };
      });
      assert.ok(scrolled.fits && scrolled.top > 0, `${label}: the body scrolls (${scrolled.top})`);
      assert.equal(
        await header.evaluate((el) => Math.round(el.getBoundingClientRect().top)),
        headerTop,
        `${label}: header stays while the body scrolls`,
      );
      assert.deepEqual(await firstLine(page), text, `${label}: body scroll moved the text`);
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }

    // A wide pane (560px): the diff switch moves into the header.
    {
      const { context, page } = await open(theme, { width: 1440, height: 900 }, '/t/1001?lang=en', {
        rightWidth: 560,
      });
      const header = page.locator('[aria-label="Compendium tools"]');
      await header.waitFor();
      assert.equal(await header.locator('[aria-label="Compendium diff view"]').count(), 1);
      assert.equal(await page.locator('[aria-label="Compendium diff view"]').count(), 1);
      assert.equal(await headerHeight(page, 'Compendium'), 28);
      assert.deepEqual(await clipped(page), [], `${theme} wide pane: header clips`);
      await noOverflow(page, `${theme} wide pane`);
      await page.screenshot({ path: out('compendium-1440-wide-pane') });
      await context.close();
    }

    // The minimum pane (320px) keeps everything on one header line.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 }, '/t/1001?lang=en', {
        rightWidth: 320,
      });
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${theme} 320 pane header`);
      assert.deepEqual(await clipped(page), [], `${theme} 320 pane: header clips`);
      await noOverflow(page, `${theme} 320 pane`);
      await page.screenshot({ path: out('compendium-320-pane') });
      await context.close();
    }

    // 800: the pane header's toggle swaps the main slot to the Compendium.
    {
      const { context, page } = await open(theme, { width: 800, height: 800 }, '/t/1001?lang=en');
      const text = await firstLine(page);
      await page.getByRole('button', { name: 'Compendium', exact: true }).click();
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      await noOverflow(page, `${theme} 800 compendium`);
      assert.deepEqual(await clipped(page), [], `${theme} 800: header clips`);
      await page.screenshot({ path: out('compendium-800-swapped') });
      await page.getByRole('button', { name: 'Compendium', exact: true }).click();
      assert.deepEqual(await firstLine(page), text, `${theme} 800: editor back in place`);
      await context.close();
    }

    // Phone: the Compendium tab shows the pane with 44px controls.
    {
      const { context, page } = await open(theme, { width: 390, height: 844 }, '/t/1001?lang=en', {
        phone: true,
      });
      await page.getByRole('tab', { name: 'Compendium' }).click();
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      const height = await headerHeight(page, 'Compendium');
      assert.ok(height >= 44, `${theme} phone header ${height}px`);
      assert.deepEqual(await clipped(page), [], `${theme} phone: header clips`);
      await noOverflow(page, `${theme} phone compendium`);
      await page.screenshot({ path: out('compendium-390') });
      await context.close();
    }

    // Translator: the English pane has its header and a "Shows" select; no Compendium.
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      const { context, page, errors } = await open(theme, { width, height }, '/t/1000?lang=de', {
        phone,
        role: 'translator',
      });
      const label = `${theme} translator ${width}`;
      if (width === 768) await page.getByRole('button', { name: 'English', exact: true }).click();
      if (phone) await page.getByRole('tab', { name: 'English' }).click();
      const header = page.locator('[aria-label="English tools"]');
      await header.waitFor();
      assert.equal(await header.locator('h3').textContent(), 'English');
      const select = header.getByLabel('English shows');
      assert.equal(await select.inputValue(), 'changes');
      assert.equal(await page.locator('[aria-label^="Compendium"]').count(), 0, 'no Compendium');
      const h = await headerHeight(page, 'English');
      assert.ok(phone ? h >= 44 : h === 28, `${label}: header ${h}px`);
      assert.deepEqual(await clipped(page), [], `${label}: header clips`);
      await noOverflow(page, label);
      const text = await firstLine(page);
      await select.selectOption('current');
      assert.deepEqual(await firstLine(page), text, `${label}: Shows moved the text`);
      assert.match(
        await page.locator('aside[aria-label="English source"]').innerText(),
        /deals/,
        `${label}: current English shown`,
      );
      await page.screenshot({ path: out(`english-${width}`) });
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }
  }
  console.log('Compendium pane browser checks passed.');
} finally {
  await browser.close();
  await server.close();
}
