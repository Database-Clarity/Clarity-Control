/* global document, window */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The finder on real generator data: the exotic armour category lists armour pieces (not perks),
// a perk search resolves to its piece, and the perk's hash still opens. Screenshots go to argv[2];
// argv[3] is the generator's items.json.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/exotic-armour-shots');
const itemsPath = process.argv[3] ?? 'D:/GitHub/Description-data-generator/templates/v2/items.json';
await mkdir(shots, { recursive: true });
const all = JSON.parse(await readFile(itemsPath, 'utf8'));
const real = Object.fromEntries(
  Object.entries(all).filter(([, item]) => item.categoryId === 'armor-trait-exotic'),
);
const port = 5292;
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
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [390, 844, true],
      [1280, 800, false],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}#/t/8507332`);
      await page.locator('header').first().waitFor();
      await page.evaluate((items) => {
        window.shellFixture.role('maintainer');
        window.shellFixture.exoticArmour(items);
        window.location.hash = '#/t/8507332';
      }, real);
      const openList = async () => {
        if (phone) {
          await page.locator('header button[aria-haspopup="dialog"][aria-expanded]').nth(1).click();
          await page.getByRole('dialog', { name: 'Find' }).waitFor();
        } else {
          await page.getByRole('combobox', { name: 'Tooltip' }).click();
        }
        await page.locator('[role="listbox"] [role="option"]').first().waitFor();
      };
      const field = page.getByRole('combobox', { name: 'Tooltip' });
      await openList();
      assert.equal(await field.getAttribute('placeholder'), 'Contraverse Hold');
      const texts = await page
        .locator('[role="listbox"] [role="option"]')
        .evaluateAll((rows) => rows.map((row) => row.textContent));
      assert.equal(texts.length, 138, `${theme} ${width}: one row per exotic perk`);
      assert.ok(texts.some((t) => t.includes('Contraverse Hold')));
      assert.ok(
        !texts.some((t) => t.startsWith('Chaotic Exchanger')),
        'perk name is not the label',
      );
      assert.ok(texts.some((t) => t.includes('Chaotic Exchanger · 8507332')));
      // Only the Aeon set's three perks, carried by three different pieces, are shared.
      const shared = texts.filter((t) => t.includes('shared perk'));
      assert.equal(shared.length, 3, `${theme} ${width}: shared rows ${shared}`);
      assert.ok(shared.every((t) => t.startsWith('Aeon Safe/Soul/Swift')));
      const geometry = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        clipped: [...document.querySelectorAll('[role="option"] small')].filter(
          (el) => el.scrollWidth > el.clientWidth + 1,
        ).length,
      }));
      assert.ok(geometry.overflowX <= 0, `${theme} ${width}: horizontal overflow`);
      await page.screenshot({ path: `${shots}/${theme}-list-${width}.png` });
      // A perk search resolves to its piece; Enter opens the perk.
      await field.fill('chaotic exch');
      const found = await page
        .locator('[role="listbox"] [role="option"]')
        .evaluateAll((rows) => rows.map((row) => row.textContent));
      assert.equal(found.length, 1);
      assert.match(found[0], /Contraverse Hold/);
      await page.screenshot({ path: `${shots}/${theme}-search-perk-${width}.png` });
      await field.fill('aeon soul');
      await page.screenshot({ path: `${shots}/${theme}-search-aeon-${width}.png` });
      await field.fill('praxic vest');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.location.hash.startsWith('#/t/'));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${shots}/${theme}-opened-${width}.png` });
      await context.close();
    }
  }
  console.log('Exotic armour list passed.');
} finally {
  await browser.close();
  await server.close();
}
