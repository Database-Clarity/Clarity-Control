/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Captures the header lockup, settings popover and a dialog in both themes (desktop + phone) from
// synthetic data, and checks computed colour contrast. Output directory: argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-s1-shots');
await mkdir(shots, { recursive: true });

const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port: 5287, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

// Settings lives in the identity menu in the header, on desktop and phone alike.
async function openSettings(page) {
  await page.locator('[data-identity-button]').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

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

try {
  for (const [scheme, theme] of [
    ['dark', 'dark'],
    ['light', 'light'],
  ]) {
    for (const [name, viewport] of [
      ['desktop', { width: 1280, height: 800 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        hasTouch: name === 'phone',
        isMobile: name === 'phone',
      });
      const page = await context.newPage();
      await page.addInitScript(
        (value) => localStorage.setItem('clarity-settings:device:v1', JSON.stringify(value)),
        { theme: 'system' },
      );
      await page.goto('http://127.0.0.1:5287/test/theme-shell.html');
      await page.locator('.cm-content').waitFor();
      // System default follows the OS; no flash means the attribute is there at first paint.
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.match(await page.title(), /^Clarity Control( — .+)?$/);
      await page.screenshot({ path: `${shots}/${name}-${theme}-header.png` });
      const brand = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('header img')].filter(
          (img) => img.getBoundingClientRect().width > 0,
        );
        return { count: visible.length, src: visible[0]?.src.slice(0, 40), alt: visible[0]?.alt };
      });
      assert.equal(brand.count, 1, 'exactly one lockup artwork is visible');
      assert.equal(brand.alt, 'Clarity Control');

      await openSettings(page);
      await page.getByRole('dialog', { name: /settings/i }).waitFor();
      await page.getByLabel('Theme').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/${name}-${theme}-settings.png` });
      const contrast = await page.evaluate(() => {
        const popover = document.querySelector('[aria-labelledby="settings-title"]');
        const bg = (el) => {
          for (let node = el; node; node = node.parentElement) {
            const c = getComputedStyle(node).backgroundColor;
            if (c && c !== 'rgba(0, 0, 0, 0)') return c;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        };
        const pairs = {};
        const label = popover.querySelector('label');
        pairs.label = [getComputedStyle(label).color, bg(label)];
        const select = popover.querySelector('select');
        pairs.select = [getComputedStyle(select).color, getComputedStyle(select).backgroundColor];
        pairs.selectBorder = [getComputedStyle(select).borderTopColor, bg(popover)];
        const hint = popover.querySelector('p');
        pairs.hint = [getComputedStyle(hint).color, bg(hint)];
        return { pairs, scheme: getComputedStyle(document.documentElement).colorScheme };
      });
      for (const [key, [fg, back]] of Object.entries(contrast.pairs)) {
        const r = ratio(rgb(fg), rgb(back));
        console.log(`${theme} ${name} ${key}: ${r.toFixed(2)} (${fg} on ${back})`);
        assert.ok(r >= (key === 'selectBorder' ? 3 : 4.5), `${theme} ${name} ${key} contrast ${r}`);
      }
      await page.getByRole('button', { name: 'Close settings' }).click();
      await page.evaluate(() => window.themeFixture.openDialog());
      await page.getByRole('dialog', { name: 'Discard draft?' }).waitFor();
      await page.screenshot({ path: `${shots}/${name}-${theme}-dialog.png` });
      await context.close();
    }
  }
  // An explicit choice beats the OS and survives reload; no flash on reload.
  const context = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5287/test/theme-shell.html');
  await page.locator('.cm-content').waitFor();
  await openSettings(page);
  await page.getByLabel('Theme').selectOption('light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  // "System" tracks the OS live, but an explicit choice (light, here) does not move.
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await openSettings(page);
  await page.getByLabel('Theme').selectOption('system');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, {
    timeout: 3000,
  });
  console.log('Theme default, override, reload persistence, contrast and screenshots passed.');
} finally {
  await browser.close();
  await server.close();
}
