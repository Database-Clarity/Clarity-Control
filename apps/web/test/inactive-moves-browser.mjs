/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';

const web = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? '.agents/reports/move-inactive-qa');
await mkdir(output, { recursive: true });
const port = Number(process.env.INACTIVE_QA_PORT ?? 5387);
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const results = [];
try {
  for (const width of [390, 768, 1280])
    for (const theme of ['light', 'dark'])
      for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
        const label = `${width}-${theme}-${scale}`;
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/test/shell.html#/t/1000?lang=en`);
        await page.locator('.cm-content').first().waitFor();
        await page.evaluate(
          ({ scale, theme }) => {
            sessionStorage.setItem('clarity-editor-session', 'synthetic');
            window.shellFixture.role('maintainer');
            document.documentElement.style.fontSize = `${scale}%`;
            document.documentElement.dataset.theme = theme;
            const state = { moves: {}, revision: null, writes: 0 };
            window.inactiveQA = state;
            window.fetch = async (url, init) => {
              if (String(url).endsWith('/inactive-moves')) {
                if (init?.method === 'PUT') {
                  const input = JSON.parse(init.body);
                  if (input.revision !== state.revision)
                    return Response.json(
                      { error: 'Inactive moves changed; reload' },
                      { status: 409 },
                    );
                  state.writes++;
                  state.moves[input.hash] = {
                    by: 1,
                    at: '2026-11-14T00:00:00Z',
                    ...(!input.inactive ? { inactive: false } : {}),
                  };
                  state.revision = String(state.writes).repeat(40);
                }
                return Response.json({ moves: state.moves, revision: state.revision });
              }
              return Response.json(
                String(url).includes('live=1')
                  ? { tooltip: null, pushedHash: null }
                  : { page: 1, commits: [] },
              );
            };
          },
          { scale, theme },
        );
        // Font changes settle through the tool row's ResizeObserver before layout assertions.
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
            }),
        );
        const trigger = page.getByRole('button', { name: 'Move to Inactive', exact: true });
        if (width <= 700) {
          assert.equal(await trigger.count(), 0, `${label}: move stays in More`);
          if (scale === 100)
            assert.equal(
              await page.getByRole('button', { name: 'Markup bar', exact: true }).isVisible(),
              true,
              `${label}: everyday Markup stays inline`,
            );
          const line = await page.evaluate(() => {
            const language = document
              .querySelector('select[aria-label="Language"]')
              .getBoundingClientRect();
            const more = document
              .querySelector('button[aria-label="More editor tools"]')
              .getBoundingClientRect();
            return { language: language.top, more: more.top };
          });
          assert.ok(
            Math.abs(line.language - line.more) < 2,
            `${label}: More stays on the language line ${JSON.stringify(line)}`,
          );
        }
        const openMove = async (name) => {
          const control = page.getByRole('button', { name, exact: true });
          if (!(await control.isVisible()) && width <= 700)
            await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
          await control.click();
        };
        await openMove('Move to Inactive');
        const dialog = page.getByRole('dialog', { name: 'Move to Inactive', exact: true });
        const confirm = dialog.getByRole('button', { name: 'Move', exact: true });
        await confirm.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role=dialog][aria-label="Move to Inactive"]');
          return [...dialog.querySelectorAll('button')].some(
            (button) => button.textContent === 'Move' && !button.disabled,
          );
        });
        assert.equal(
          await dialog.evaluate(
            (node) =>
              node.contains(document.activeElement) && document.activeElement.tagName === 'DIV',
          ),
          true,
          `${label}: explanation focus`,
        );
        assert.equal(await dialog.locator('input').count(), 0, `${label}: no typed-name step`);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        assert.equal(
          await page.evaluate(() => window.inactiveQA.writes),
          0,
          `${label}: autopilot keys`,
        );
        const layout = await page.evaluate(() => {
          const dialog = document.querySelector('[role=dialog]');
          const rect = dialog.getBoundingClientRect();
          const controls = [...dialog.querySelectorAll('button, input')];
          const clipped = controls
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent);
          const headerControls = [
            ...document.querySelectorAll(
              '[role=group][aria-label="Editor tools"] button, [role=group][aria-label="Editor tools"] select',
            ),
          ].filter(
            (node) =>
              node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden',
          );
          const overlaps = [];
          for (let i = 0; i < headerControls.length; i++)
            for (let j = i + 1; j < headerControls.length; j++) {
              const a = headerControls[i].getBoundingClientRect(),
                b = headerControls[j].getBoundingClientRect();
              if (
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
              )
                overlaps.push([headerControls[i].textContent, headerControls[j].textContent]);
            }
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            left: rect.left,
            right: rect.right,
            clipped,
            overlaps,
          };
        });
        assert.ok(
          layout.overflow <= 1 && layout.left >= 0 && layout.right <= width + 1,
          `${label}: ${JSON.stringify(layout)}`,
        );
        assert.deepEqual(layout.clipped, [], `${label}: clipped controls`);
        assert.deepEqual(layout.overlaps, [], `${label}: overlapping header controls`);
        await page.screenshot({ path: resolve(output, `${label}-confirm.png`), fullPage: true });
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0, `${label}: Escape`);
        await openMove('Move to Inactive');
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role=dialog][aria-label="Move to Inactive"]');
          return [...dialog.querySelectorAll('button')].some(
            (button) => button.textContent === 'Move' && !button.disabled,
          );
        });
        // Native browser activation: opening keys cannot confirm; Tab must reach Move first.
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => window.inactiveQA.writes), 0, `${label}: reopen`);
        await page.keyboard.press('Tab');
        assert.equal(
          await dialog
            .getByRole('button', { name: 'Cancel', exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
          `${label}: first Tab reaches Cancel`,
        );
        await page.keyboard.press('Tab');
        assert.equal(
          await confirm.evaluate((node) => node === document.activeElement),
          true,
          `${label}: Tab reaches Move`,
        );
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.inactiveQA.writes === 1);
        await page
          .getByRole('note')
          .filter({ hasText: 'Inactive — excluded from outputs' })
          .waitFor();
        assert.equal(
          await page
            .getByRole('note')
            .filter({ hasText: 'Inactive — excluded from outputs' })
            .isVisible(),
          true,
          `${label}: editor notice`,
        );
        assert.equal(
          await page.locator('.cm-content').first().getAttribute('contenteditable'),
          'true',
          `${label}: still editable`,
        );
        await page.screenshot({ path: resolve(output, `${label}-inactive.png`), fullPage: true });
        if (width === 390 || width === 1280) {
          await page.evaluate(() => {
            window.location.hash = '#/review?hash=1000';
          });
          await page.getByText(/Pending removal:/).waitFor();
          await page.locator('[data-mark="Remove"]').first().waitFor();
          await page.screenshot({
            path: resolve(output, `${label}-review-removal.png`),
            fullPage: true,
          });
          await page.evaluate(() => {
            window.location.hash = '#/t/1000?lang=en';
          });
          await page.locator('.cm-content:visible').first().waitFor();
        }
        await openMove('Move out of Inactive');
        const restore = page.getByRole('dialog', { name: 'Move out of Inactive', exact: true });
        const restoreMove = restore.getByRole('button', { name: 'Move', exact: true });
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role=dialog][aria-label="Move out of Inactive"]');
          return [...dialog.querySelectorAll('button')].some(
            (button) => button.textContent === 'Move' && !button.disabled,
          );
        });
        await page.keyboard.press('Space');
        assert.equal(
          await page.evaluate(() => window.inactiveQA.writes),
          1,
          `${label}: restore opening Space`,
        );
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        assert.equal(
          await restoreMove.evaluate((node) => node === document.activeElement),
          true,
          `${label}: Tab reaches restore Move`,
        );
        await page.keyboard.press('Space');
        await page
          .getByRole('note')
          .filter({ hasText: 'Inactive — excluded from outputs' })
          .waitFor({ state: 'hidden' });
        if (width > 700) await trigger.waitFor();
        assert.equal(
          await page.evaluate(() => window.inactiveQA.writes),
          2,
          `${label}: move in/out`,
        );
        results.push({
          label,
          layout,
          moveInOut: true,
          openingKeysBlocked: true,
          tabEnterConfirms: true,
          tabSpaceRestores: true,
          editable: true,
        });
        await context.close();
      }
  for (const width of [768, 1024, 1280, 1440])
    for (const theme of ['light', 'dark'])
      for (const scale of [100, 150]) {
        const label = `override-draft-${width}-${theme}-${scale}`;
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/test/shell.html#/t/1001?lang=en`);
        await page.locator('.cm-content').first().waitFor();
        await page.evaluate(
          ({ scale, theme }) => {
            window.shellFixture.role('maintainer');
            window.shellFixture.variants();
            window.location.hash = '#/t/1001?lang=en';
            document.documentElement.style.fontSize = `${scale}%`;
            document.documentElement.dataset.theme = theme;
            window.fetch = async () => Response.json({ moves: {}, revision: null });
          },
          { scale, theme },
        );
        await page
          .getByRole('button', { name: /^Edit override/ })
          .first()
          .click();
        const editor = page.locator('.cm-content[contenteditable=true]:visible').first();
        await editor.click();
        await page.keyboard.type('x');
        await page
          .getByRole('group', { name: 'Editor tools', exact: true })
          .getByRole('img', { name: 'Unsaved draft', exact: true })
          .waitFor();
        const layout = await page.evaluate(() => {
          const header = document.querySelector('[role=group][aria-label="Editor tools"]');
          const bounds = header.getBoundingClientRect();
          const controls = [...header.querySelectorAll('button, select')].filter(
            (node) =>
              node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden',
          );
          const outside = controls
            .filter((node) => {
              const r = node.getBoundingClientRect();
              return r.left < bounds.left - 1 || r.right > bounds.right + 1;
            })
            .map((node) => node.getAttribute('aria-label') || node.textContent);
          return { outside, headerWidth: bounds.width, controlCount: controls.length };
        });
        assert.deepEqual(layout.outside, [], `${label}: unreachable header controls`);
        await page.getByRole('button', { name: 'Move to Inactive', exact: true }).click();
        await page.getByRole('dialog', { name: 'Move to Inactive', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.screenshot({ path: resolve(output, `${label}.png`), fullPage: true });
        results.push({ label, layout, inactiveReachable: true });
        await context.close();
      }
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASS ${results.length} inactive-move render/flow cases: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
