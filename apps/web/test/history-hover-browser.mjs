/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';

// Starts its own server (VITE_API_URL set, so the panel treats the user as signed in);
// all data is synthetic. Screenshots go to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s10-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.HISTORY_HOVER_PORT ?? 5238);
const url = `http://127.0.0.1:${port}/test/history-hover.html`;
// A production build of the test pages by default (harness-server.mjs).
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const dialog = (page) => page.locator('[role="dialog"]');
async function check(page, label) {
  const result = await page.evaluate(() => {
    const popover = document.querySelector('[role="dialog"]');
    const rect = popover?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      popover: rect && {
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        top: rect.top,
        inner: popover.scrollWidth - popover.clientWidth,
      },
      width: window.innerWidth,
      height: window.innerHeight,
      clipped: [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().height > 60)
        .map((b) => b.textContent),
    };
  });
  // scrollWidth - clientWidth is negative when nothing overflows (a classic scrollbar).
  assert.ok(result.overflow <= 0, `${label}: horizontal overflow ${result.overflow}`);
  assert.ok(result.popover.left >= 0 && result.popover.right <= result.width, `${label}: x`);
  assert.ok(result.popover.bottom <= result.height + 1, `${label}: popover bottom in viewport`);
  assert.equal(result.popover.inner, 0, `${label}: popover content overflows sideways`);
  assert.deepEqual(result.clipped, [], `${label}: clipped/wrapped controls`);
}
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, scale] of [
      [390, 844, 16],
      [768, 800, 16],
      [1280, 800, 16],
      [1280, 800, 13.6],
      [768, 800, 24],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        colorScheme: theme,
        hasTouch: width < 500,
      });
      await page.addInitScript(
        (t) => document.documentElement.setAttribute('data-theme', t),
        theme,
      );
      await page.goto(url);
      await page.evaluate(
        ([t, s]) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.style.fontSize = `${s}px`;
        },
        [theme, scale],
      );
      await page.getByRole('button', { name: /History/ }).click();
      const entries = page.locator('ol li > button');
      await entries.first().waitFor();
      const before = await entries.evaluateAll((all) =>
        all.map((b) => JSON.stringify(b.getBoundingClientRect())),
      );
      const name = `${theme}-${width}${scale === 16 ? '' : `-s${scale}`}`;
      // Hover opens (desktop); phones pin by tapping.
      if (width >= 500) await entries.nth(2).hover();
      else await entries.nth(2).tap();
      await dialog(page).waitFor();
      await dialog(page).getByText('Loading revision').waitFor({ state: 'detached' });
      await check(page, `${name} open`);
      const after = await entries.evaluateAll((all) =>
        all.map((b) => JSON.stringify(b.getBoundingClientRect())),
      );
      assert.deepEqual(after, before, `${name}: the list moved while the popover was open`);
      assert.ok((await dialog(page).locator('ins, del').count()) > 0, `${name}: word diff shown`);
      await page.screenshot({ path: `${shots}/${name}.png` });
      if (scale === 16) {
        // Pin by click, compare with current, confirm step shows and keeps the layout.
        if (width >= 500) {
          await entries.nth(2).click();
          await page.mouse.move(width - 5, 5);
          await page.waitForTimeout(400);
        }
        await dialog(page).waitFor();
        await dialog(page)
          .getByRole('button', { name: /vs current draft/ })
          .click();
        await dialog(page).getByRole('button', { name: 'Restore this revision' }).click();
        await check(page, `${name} pinned/compare/confirm`);
        await page.screenshot({ path: `${shots}/${name}-pinned.png` });
        await page.keyboard.press('Escape');
        await dialog(page).waitFor({ state: 'detached' });
      }
      // The last entry (page boundary, no more pages) is the first revision.
      await page.close();
    }
  }
  console.log('history hover browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
