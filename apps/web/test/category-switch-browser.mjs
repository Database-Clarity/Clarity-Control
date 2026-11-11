/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The Stat-only Parts | Parts with Effects switch in the editor column, in the real shell: both
// labels and the help line are fully readable (no clipping, no ellipsis) at 390 / 768 / 1280, with the
// left column at its 280px minimum, both themes, UI scale 100 and 150. Usage: node <this> [shots dir].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/category-switch-shots');
await mkdir(shots, { recursive: true });

process.env.VITE_API_URL = 'https://api.fixture.invalid';
const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const url = `${server.resolvedUrls.local[0]}test/category-switch.html`;
const browser = await chromium.launch({
  executablePath:
    process.env.PERF_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

/** Every text box in the row shows all of its text: nothing clipped, overflowing, or ellipsised. */
const problems = (page) =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll('[aria-label="Attachment category"]')].find(
      (el) => el.offsetParent,
    )?.parentElement;
    if (!row) return ['no switch'];
    const out = [];
    const rowRect = row.getBoundingClientRect();
    for (const el of row.querySelectorAll('button, small, p')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const style = getComputedStyle(el);
      if (r.right > rowRect.right + 1 || r.right > window.innerWidth + 1)
        out.push(`${el.textContent} past the row`);
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        out.push(`${el.textContent} clipped`);
      if (style.textOverflow === 'ellipsis' && style.overflow !== 'visible')
        out.push(`${el.textContent} can ellipsise`);
    }
    const buttons = [...row.querySelectorAll('[role="group"] button')];
    const heights = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height)));
    if (heights.size > 1) out.push(`button heights differ: ${[...heights]}`);
    if (document.documentElement.scrollWidth > window.innerWidth)
      out.push('page scrolls horizontally');
    return out;
  });

const failures = [];
try {
  for (const theme of ['dark', 'light'])
    for (const scale of [1, 1.5])
      for (const [width, height, phone, editorMin] of [
        [1280, 800, false, false],
        [768, 900, false, false],
        [390, 844, true, false],
        [1280, 800, false, true],
      ])
        for (const hash of [5699512, 3721627275]) {
          const label = `${theme}-ui${scale * 100}-${width}${editorMin ? '-min' : ''}-${hash}`;
          const context = await browser.newContext({
            viewport: { width, height },
            colorScheme: theme,
            hasTouch: phone,
            isMobile: phone,
          });
          await context.addInitScript(
            ([value, narrow]) => {
              localStorage.setItem(
                'clarity-settings:device:v1',
                JSON.stringify({
                  uiScale: value,
                  // The left column at its 280 design-pixel minimum.
                  ...(narrow && { panes: { 'editor:left': { width: 280, collapsed: false } } }),
                }),
              );
            },
            [scale * 100, editorMin],
          );
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator('header').first().waitFor();
          await page.locator('.cm-content').first().waitFor({ state: 'attached' });
          await page.evaluate((h) => {
            window.location.hash = `#/t/${h}?lang=en`;
          }, hash);
          if (phone) await page.getByRole('tab', { name: 'Preview' }).click();
          else {
            // Compact windows start with the column collapsed: open it like the user would.
            const show = page.getByRole('button', { name: /Show preview column/ });
            if (await show.count()) await show.first().click();
          }
          const row = page.locator('[aria-label="Attachment category"]:visible').first();
          await row.waitFor({ timeout: 10_000 }).catch(async (error) => {
            await page.screenshot({ path: `${shots}/${label}-missing.png` });
            throw new Error(`${label}: ${error.message}`);
          });
          const box = row.locator('xpath=..');
          await box.screenshot({ path: `${shots}/${label}.png` });
          const found = [...(await problems(page)), ...errors];
          if (found.length) failures.push(`${label}: ${found.join('; ')}`);
          await context.close();
        }
} finally {
  await browser.close();
  await server.close();
}
console.log(failures.length ? failures.join('\n') : 'category switch: all readable');
assert.deepEqual(failures, []);
