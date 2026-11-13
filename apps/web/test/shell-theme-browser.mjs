/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Shell/theme render QA on the header-shell fixture (synthetic data, no network): the light theme
// at 390/768/1280, the Settings gear (open, Escape, focus return), phone header buttons across the
// interface scale, and the editor text size setting. Screenshots go to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/shell-theme-shots');
await mkdir(shots, { recursive: true });
const port = 5311;
const url = `http://127.0.0.1:${port}/test/header-shell.html`;
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
const deviceKey = 'clarity-settings:device:v1';

async function open(theme, viewport, device = {}, phone = false) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  await context.addInitScript(
    ([key, value]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    [deviceKey, JSON.stringify({ theme, ...device })],
  );
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.locator('.cm-content').waitFor();
  await page.evaluate(() => window.shellFixture.role('maintainer'));
  await page.evaluate(() => window.shellFixture.drafts(3));
  return { context, page };
}
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const report = {};

try {
  for (const theme of ['light', 'dark']) {
    for (const [name, viewport, phone] of [
      ['1280', { width: 1280, height: 800 }, false],
      ['768', { width: 768, height: 900 }, false],
      ['390', { width: 390, height: 844 }, true],
    ]) {
      const { context, page } = await open(theme, viewport, {}, phone);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.ok((await overflow(page)) <= 0, `${theme} ${name}: horizontal overflow`);
      await page.screenshot({ path: `${shots}/${theme}-${name}-editor.png` });
      // The gear is a header button, not in the account menu.
      const gear = page.locator('[data-settings-button]');
      assert.equal(await gear.count(), 1);
      const box = await gear.boundingBox();
      if (phone) assert.ok(box.width >= 44 && box.height >= 44, `gear target ${box.width}x${box.height}`);
      await page.locator('[data-identity-button]').click();
      const menu = page.getByRole('dialog', { name: 'Account' });
      await menu.waitFor();
      assert.equal(await menu.getByRole('button', { name: 'Settings' }).count(), 0);
      await page.keyboard.press('Escape');
      // Open, Escape, focus returns to the gear.
      await gear.click();
      await page.getByRole('dialog', { name: /settings/i }).waitFor();
      assert.equal(await gear.getAttribute('aria-expanded'), 'true');
      assert.ok((await overflow(page)) <= 0, `${theme} ${name}: overflow with settings`);
      await page.screenshot({ path: `${shots}/${theme}-${name}-settings.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: /settings/i }).waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(() => document.activeElement?.hasAttribute('data-settings-button')),
        true,
        'focus returns to the gear',
      );
      await context.close();
    }
  }

  // Phone header buttons follow the interface scale, never under 44px, never overflowing.
  report.phoneButtons = {};
  for (const scale of [85, 100, 115, 125, 150]) {
    const { context, page } = await open('light', { width: 390, height: 844 }, { uiScale: scale }, true);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('header > button, header > div > button')]
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
        })
        .filter((s) => s.w > 0),
    );
    const title = await page.locator('header h1, header [data-tooltip-finder]').first().boundingBox();
    report.phoneButtons[scale] = { sizes, titleWidth: Math.round(title.width) };
    for (const s of sizes) {
      assert.ok(s.w >= 44 && s.h >= 44, `scale ${scale}: target ${s.w}x${s.h}`);
      assert.ok(s.right <= 390, `scale ${scale}: button off screen`);
    }
    assert.ok((await overflow(page)) <= 0, `scale ${scale}: overflow`);
    await page.screenshot({ path: `${shots}/light-390-scale${scale}.png`, clip: { x: 0, y: 0, width: 390, height: 120 } });
    await context.close();
  }

  // Editor text size: independent of the interface scale, persisted per device.
  {
    const { context, page } = await open('dark', { width: 1280, height: 800 }, { uiScale: 100 });
    const size = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.cm-editor')).fontSize);
    const base = await size();
    report.editorDefault = base;
    await page.locator('[data-settings-button]').click();
    const dialog = page.getByRole('dialog', { name: /settings/i });
    await dialog.getByLabel('Editor text size').selectOption('20');
    assert.equal(await size(), '20px');
    await dialog.getByRole('slider').fill('150');
    assert.equal(await size(), '20px', 'editor text size does not follow the interface scale');
    await dialog.getByLabel('Editor text size').selectOption('');
    report.editorAutoAt150 = await size();
    assert.notEqual(report.editorAutoAt150, base, 'automatic still follows the scale');
    await dialog.getByLabel('Editor text size').selectOption('18');
    await page.reload();
    await page.locator('.cm-content').waitFor();
    assert.equal(await size(), '18px', 'size survives reload');
    await context.close();
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  await server.close();
}
