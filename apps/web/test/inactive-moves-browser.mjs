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
              return Response.json({ page: 1, commits: [] });
            };
          },
          { scale, theme },
        );
        const trigger = page.getByRole('button', { name: 'Move to Inactive', exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Move to Inactive', exact: true });
        const input = dialog.locator('input');
        await input.waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('[role=dialog] input').disabled);
        assert.equal(
          await dialog
            .getByRole('button', { name: 'Cancel', exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
          `${label}: Cancel focus`,
        );
        const confirm = dialog.getByRole('button', { name: 'Stop exporting', exact: true });
        assert.equal(await confirm.isDisabled(), true, `${label}: empty confirmation`);
        await input.fill('Hammerhead');
        await confirm.focus();
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
        await trigger.click();
        await page.waitForFunction(() => !document.querySelector('[role=dialog] input').disabled);
        assert.equal(await input.inputValue(), '', `${label}: reset`);
        await input.fill('Hammerhead');
        await confirm.click();
        await page.getByRole('button', { name: 'Move out of Inactive', exact: true }).waitFor();
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
        await page.getByRole('button', { name: 'Move out of Inactive', exact: true }).click();
        const restore = page.getByRole('dialog', { name: 'Move out of Inactive', exact: true });
        await restore.locator('input').fill('Hammerhead');
        await restore.getByRole('button', { name: 'Resume exporting', exact: true }).click();
        await trigger.waitFor();
        assert.equal(
          await page.evaluate(() => window.inactiveQA.writes),
          2,
          `${label}: move in/out`,
        );
        results.push({ label, layout, moveInOut: true, keysBlocked: true, editable: true });
        await context.close();
      }
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASS ${results.length} inactive-move render/flow cases: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
