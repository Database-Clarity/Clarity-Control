/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The finder list on the shell fixture, both themes, at the three design widths: a base with an
// enhanced version carries "+E" (and nothing else does), the row does not clip or scroll
// sideways. Screenshots go to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s1-shots');
await mkdir(shots, { recursive: true });
const port = 5291;
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
      [768, 900, false],
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
      await page.goto(url);
      await page.locator('header').first().waitFor();
      await page.evaluate(() => window.shellFixture.role('maintainer'));
      if (phone) {
        // The finder sheet opens with its list showing.
        await page.locator('header button[aria-haspopup="dialog"][aria-expanded]').nth(1).click();
        await page.getByRole('dialog', { name: 'Find' }).waitFor();
      } else {
        await page.getByRole('combobox', { name: 'Tooltip' }).click();
      }
      const options = page.locator('[role="listbox"] [role="option"]');
      await options.first().waitFor();
      const marks = await options.evaluateAll((rows) =>
        rows.map((row) => [row.textContent, !!row.querySelector('small span')]),
      );
      const marked = marks.filter(([, mark]) => mark).map(([text]) => text);
      assert.equal(marked.length, 1, `${theme} ${width}: exactly one +E row (${marked})`);
      assert.match(marked[0], /Telesto/);
      assert.match(marked[0], /\+E/);
      const geometry = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[role="option"]')].find((el) =>
          el.querySelector('small span'),
        );
        const small = row.querySelector('small');
        return {
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          rowHeight: row.getBoundingClientRect().height,
          smallClipped: small.scrollWidth > small.clientWidth + 1,
          smallRight: small.getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
        };
      });
      assert.ok(
        geometry.overflowX <= 0,
        `${theme} ${width}: horizontal overflow ${geometry.overflowX}`,
      );
      assert.ok(
        geometry.rowHeight <= 40 || phone,
        `${theme} ${width}: row wraps (${geometry.rowHeight})`,
      );
      assert.ok(!geometry.smallClipped, `${theme} ${width}: +E label clipped`);
      assert.ok(
        geometry.smallRight <= geometry.rowRight + 1,
        `${theme} ${width}: label outside row`,
      );
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${shots}/${theme}-finder-${width}.png` });
      await context.close();
    }
  }
  console.log('Finder +E rows passed.');
} finally {
  await browser.close();
  await server.close();
}
