/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Run with the web dev server on 5199; all application data/API are synthetic.
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:5199/test/font-settings.html');
  await page.locator('.cm-content').waitFor();
  const shots = 'D:/GitHub/Description-editor/.agents/reports/font-settings-shots';
  await mkdir(shots, { recursive: true });
  const fontState = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.cm-content'));
      return {
        family: style.fontFamily,
        ligatures: style.fontVariantLigatures,
        features: style.fontFeatureSettings,
        requests: performance
          .getEntriesByType('resource')
          .filter((x) => /fira-code.*woff2|jetbrains.*woff2/.test(x.name))
          .map((x) => x.name),
      };
    });
  assert.equal((await fontState()).requests.length, 0);
  assert.equal((await fontState()).ligatures, 'none');
  await page.screenshot({ path: `${shots}/default.png` });
  await page.locator('.settings-link').click();
  await page
    .locator('label')
    .filter({ hasText: 'Editor font' })
    .locator('select')
    .selectOption('fira-code');
  await page.screenshot({ path: `${shots}/settings.png` });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.evaluate(() => document.fonts.ready);
  const chosen = await fontState();
  assert.match(chosen.family, /Fira Code/);
  assert.equal(chosen.ligatures, 'none');
  assert.match(chosen.features, /"liga" 0/);
  assert.match(chosen.features, /"calt" 0/);
  assert.equal(chosen.requests.length, 1);
  assert.match(chosen.requests[0], /^http:\/\/127.0.0.1:5199\//);
  await page.screenshot({ path: `${shots}/fira-code.png` });
  await page.reload();
  await page.locator('.cm-content').waitFor();
  assert.match((await fontState()).family, /Fira Code/);
  console.log(
    'Font defaults, lazy local loading, ligature CSS, live application and reload persistence passed.',
  );
} finally {
  await browser.close();
}
