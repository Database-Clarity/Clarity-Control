/* global window, document */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';

const output = resolve(process.argv[2] ?? '.agents/reports/entry-marks-qa');
await mkdir(output, { recursive: true });
const server = await startHarnessServer(resolve(import.meta.dirname, '..'), 5397);
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
        await page.goto('http://127.0.0.1:5397/test/shell.html');
        await page.locator('.cm-content').first().waitFor();
        await page.evaluate(
          ({ scale, theme }) => {
            sessionStorage.setItem('clarity-editor-session', 'synthetic');
            document.documentElement.style.fontSize = `${scale}%`;
            document.documentElement.dataset.theme = theme;
            window.shellFixture.role('maintainer');
            const at = '2026-11-15T00:00:00Z';
            const data = {
              types: [{ id: 'retest', label: 'Needs retesting', colour: 'amber', by: 1, at }],
              entries: { 1000: [{ type: 'retest', note: 'Test Arc damage', by: 1, at }] },
            };
            window.shellFixture.marks(data);
            let revision = 'a'.repeat(40);
            window.fetch = async (url, init) => {
              if (String(url).endsWith('/marks')) {
                if (init?.method === 'PUT') {
                  const { change, revision: expected } = JSON.parse(init.body);
                  if (expected !== revision)
                    return Response.json({ error: 'Marks changed; reload' }, { status: 409 });
                  if (change.action === 'mark')
                    data.entries[1000] = [{ type: change.type, note: change.note, by: 1, at }];
                  if (change.action === 'unmark') data.entries = {};
                  if (change.action === 'remove-type') {
                    data.types = [];
                    data.entries = {};
                  }
                  if (change.action === 'edit-type')
                    data.types[0] = {
                      ...data.types[0],
                      label: change.label,
                      colour: change.colour,
                    };
                  if (change.action === 'create-type')
                    data.types.push({
                      id: change.id,
                      label: change.label,
                      colour: change.colour,
                      by: 1,
                      at,
                    });
                  revision = 'b'.repeat(40);
                }
                return Response.json({ marks: data, revision });
              }
              if (String(url).endsWith('/permissions'))
                return Response.json({
                  permissions: { users: { 1: { login: 'pat', role: 'maintainer' } } },
                  revision: 'c'.repeat(40),
                });
              return Response.json(
                String(url).includes('live=1')
                  ? { tooltip: null, pushedHash: null }
                  : { page: 1, commits: [] },
              );
            };
          },
          { scale, theme },
        );
        const trigger = page.getByRole('button', { name: 'Entry marks', exact: true });
        await trigger.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Entry marks', exact: true });
        await dialog.getByRole('button', { name: 'Edit mark', exact: true }).click();
        await dialog.getByLabel('Optional note').fill('Retest reload timing');
        await dialog.getByRole('button', { name: 'Save mark', exact: true }).click();
        await dialog
          .locator('p')
          .filter({ hasText: /^Retest reload timing$/ })
          .waitFor();
        await page.screenshot({ path: resolve(output, `header-${label}.png`), fullPage: true });
        const check = async () => {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          assert.equal(overflow, false, `${label}: horizontal overflow`);
          for (const control of await page
            .locator(
              '[role="dialog"] button, [role="dialog"] textarea, [role="dialog"] select, section[aria-label="Mark types"] button, section[aria-label="Mark types"] input, section[aria-label="Mark types"] select',
            )
            .all()) {
            const box = await control.boundingBox();
            if (box)
              assert.ok(
                box.x >= -1 && box.x + box.width <= width + 1,
                `${label}: clipped control ${await control.textContent()}`,
              );
          }
        };
        await check();
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0);
        for (const role of ['translator', 'trial', 'out']) {
          await page.evaluate((role) => window.shellFixture.role(role), role);
          await trigger.click();
          await dialog.getByText('Marks are read-only.', { exact: true }).waitFor();
          assert.equal(await dialog.locator('textarea').count(), 0);
          await check();
          await page.keyboard.press('Escape');
        }
        await page.evaluate(() => window.shellFixture.role('maintainer'));
        await trigger.click();
        await dialog.getByRole('button', { name: 'Edit mark', exact: true }).click();
        await dialog.getByRole('button', { name: 'Remove mark', exact: true }).click();
        await dialog.getByText('No marks on this entry.', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          window.location.hash = '#/management';
        });
        const management = page.getByRole('region', { name: 'Mark types', exact: true });
        await management.getByLabel('Type name').waitFor();
        await management.getByRole('button', { name: 'Edit Needs retesting', exact: true }).click();
        await management.getByLabel('Type name').fill('Needs retesting after patch');
        await management.getByLabel('Colour').selectOption('red');
        await management.getByRole('button', { name: 'Save type', exact: true }).click();
        await management
          .getByRole('button', { name: 'Remove Needs retesting after patch', exact: true })
          .waitFor();
        await page.screenshot({ path: resolve(output, `management-${label}.png`), fullPage: true });
        await check();
        await management
          .getByRole('button', { name: 'Remove Needs retesting after patch', exact: true })
          .click();
        await management.getByRole('button', { name: 'Cancel removal', exact: true }).click();
        await context.close();
        results.push({ label, result: 'PASS' });
        console.log(`${label}: PASS`);
      }
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
  await server.close();
}
