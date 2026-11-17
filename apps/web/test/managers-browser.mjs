/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';

// Render QA for translation managers (synthetic data, managers.tsx): the Translators popover on
// Translations, the upload rollback confirm in History, and Management's "Manages" row, at
// 390/768/1280, both themes, UI 100% and 150% (phones also 120%). Screenshots go to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/tr-manager/shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.MANAGERS_PORT ?? 5291);
const base = `http://127.0.0.1:${port}/test/managers.html`;
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

/** Page-level overflow, and controls inside `scope` whose text is cut or wrapped. */
async function layout(page, scope, label, pageOverflow = true) {
  const result = await page.evaluate((selector) => {
    const roots = [...document.querySelectorAll(selector)];
    const controls = roots.flatMap((root) => [...root.querySelectorAll('button, input, select')]);
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: controls
        .filter((c) => c.getClientRects().length && c.scrollWidth > c.clientWidth + 1)
        .map((c) => c.textContent || c.getAttribute('aria-label')),
      wrapped: controls
        .filter((c) => c.tagName === 'BUTTON' && c.getClientRects().length > 1)
        .map((c) => c.textContent),
      outside: roots
        .map((root) => root.getBoundingClientRect())
        .filter((r) => r.left < -0.5 || r.right > window.innerWidth + 0.5)
        .map((r) => `${r.left},${r.right}`),
    };
  }, scope);
  if (pageOverflow)
    assert.ok(result.overflow <= 0, `${label}: horizontal overflow ${result.overflow}`);
  assert.deepEqual(result.clipped, [], `${label}: clipped controls`);
  assert.deepEqual(result.wrapped, [], `${label}: wrapped buttons`);
  assert.deepEqual(result.outside, [], `${label}: surface outside the viewport`);
}

const configs = [
  [390, 844, 16],
  [390, 844, 19.2],
  [390, 844, 24],
  [768, 900, 16],
  [768, 900, 24],
  [1280, 800, 16],
  [1280, 800, 24],
];
const writes = (page) => page.evaluate(() => window.writes.filter((w) => w.includes('rollback')));
const errors = [];
try {
  for (const theme of ['dark', 'light'])
    for (const [width, height, scale] of configs) {
      const tag = `${theme}-${width}-${Math.round((scale / 16) * 100)}`;
      const open = async (view) => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme: theme,
          hasTouch: width < 500,
        });
        page.on('pageerror', (error) => errors.push(`${tag} ${view}: ${error.message}`));
        await page.addInitScript(
          ([t, s]) => {
            const root = document.documentElement;
            if (!root) return;
            root.setAttribute('data-theme', t);
            root.style.fontSize = `${s}px`;
          },
          [theme, scale],
        );
        await page.goto(`${base}?view=${view}`);
        await page.evaluate(
          ([t, s]) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.style.fontSize = `${s}px`;
          },
          [theme, scale],
        );
        return page;
      };

      // Translations: the Translators popover.
      let page = await open('translations');
      const trigger = page.getByRole('button', { name: 'Translators', exact: true });
      await trigger.waitFor();
      await layout(page, 'main', `${tag} translations bar`);
      await page.screenshot({ path: `${shots}/translations-bar-${tag}.png` });
      await trigger.click();
      await page.getByRole('list', { name: 'French translators' }).waitFor();
      await layout(page, '[role="dialog"]', `${tag} translators popover`);
      await page.screenshot({ path: `${shots}/translators-${tag}.png` });
      if (width === 1280 && scale === 16) {
        // Add, a refused add, remove; Escape returns focus to the trigger.
        await page.getByRole('textbox', { name: 'GitHub login to add' }).fill('newbie');
        await page.keyboard.press('Enter');
        await page.getByRole('status').filter({ hasText: 'Added newbie.' }).waitFor();
        await page.getByRole('textbox', { name: 'GitHub login to add' }).fill('bob');
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'only translators' }).waitFor();
        await page.getByRole('button', { name: 'Remove gail as French translator' }).click();
        await page.getByRole('status').filter({ hasText: 'Removed gail.' }).waitFor();
        await page.screenshot({ path: `${shots}/translators-after-${tag}.png` });
        await page.keyboard.press('Escape');
        assert.equal(
          await page.evaluate(() => document.activeElement?.textContent),
          'Translators',
          'Escape returns focus to the trigger',
        );
      }
      await page.close();

      // History: the upload rollback confirm.
      page = await open('history');
      await page
        .getByRole('button', { name: /History/ })
        .first()
        .click();
      const entry = page.locator('ol li > button').first();
      await entry.waitFor();
      await entry.click();
      const rollback = page.getByRole('button', { name: 'Roll back this upload (French)' });
      await rollback.waitFor();
      await layout(page, '[role="dialog"]', `${tag} history revision`);
      await rollback.click();
      const confirm = page.getByRole('button', { name: 'Roll back 8' });
      await confirm.waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === 'Roll back 8');
      assert.deepEqual(await writes(page), [], `${tag}: no write before the confirm`);
      await layout(page, '[role="dialog"]', `${tag} rollback confirm`);
      await page.screenshot({ path: `${shots}/rollback-confirm-${tag}.png` });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.waitForFunction(
        () => document.activeElement?.textContent === 'Roll back this upload (French)',
      );
      if (width === 390 && scale === 16) {
        await rollback.click();
        await confirm.click();
        const outcome = page.getByRole('status').filter({ hasText: 'Rolled back French in 8' });
        await outcome.waitFor();
        await page.waitForFunction(() =>
          document.activeElement?.textContent?.startsWith('Rolled back French in 8'),
        );
        assert.deepEqual(
          await writes(page),
          ['POST /rollback/upload'],
          `${tag}: one write after the confirm`,
        );
        await page.screenshot({ path: `${shots}/rollback-done-${tag}.png` });
      }
      await page.close();

      // Management: the Manages row.
      page = await open('management');
      await page.getByRole('group', { name: 'erin-the-manager: manages' }).waitFor();
      // The Manages rows themselves: nothing clipped or wrapped. The page: no overflow beyond
      // what the table already shows without them (v2's table overflows at 768 px and 150%).
      await layout(page, '[role="group"][aria-label$=": manages"]', `${tag} manages rows`, false);
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      const withRows = await overflow();
      await page.addStyleTag({
        content: '[role="group"][aria-label$=": manages"] { display: none !important; }',
      });
      const withoutRows = await overflow();
      await page.addStyleTag({
        content: '[role="group"][aria-label$=": manages"] { display: flex !important; }',
      });
      assert.ok(withRows <= Math.max(0, withoutRows), `${tag} management: overflow ${withRows}`);
      if (withoutRows > 0) console.log(`${tag}: v2 Management overflow ${withoutRows} (OPEN)`);
      await page
        .getByRole('row')
        .filter({ hasText: 'erin-the-manager' })
        .screenshot({ path: `${shots}/management-row-${tag}.png` });
      await page.close();
      console.log(`${tag}: pass`);
    }
  assert.deepEqual(errors, [], 'page errors');
  console.log('MANAGERS RENDER QA PASS');
} finally {
  await browser.close();
  await server.close();
}
