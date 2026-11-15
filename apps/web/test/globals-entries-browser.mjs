/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const output = resolve(process.argv[2] ?? '.agents/reports/globals-s3-shots');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve('apps/web'),
  configLoader: 'runner',
  server: { host: '127.0.0.1', port: 5296, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const open = async (role = 'maintainer') => {
    await page.goto(`http://127.0.0.1:5296/test/globals-entries.html?role=${role}`);
    await page.getByRole('heading', { name: 'Damage', exact: true }).waitFor();
    await page.locator('.cm-content').waitFor();
  };
  const edit = async (value) => {
    const input = page.locator('.cm-content');
    await input.click();
    await input.press('ControlOrMeta+A');
    await input.pressSequentially(value);
  };
  await open();
  await edit('25%');
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).click();
  await page.getByText('Projected impact — unsaved', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('global-title');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.match(await page.locator('.cm-content').innerText(), /25%/);
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('global-title');
  await page.getByRole('button', { name: 'Discard and continue' }).click();
  await page.getByRole('heading', { name: 'Reload', exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: 'Damage', exact: true }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Reload', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('global-damage');
  await edit('30%');
  await page.evaluate(() => {
    window.globalsFixture.next = 'retry';
  });
  await page.getByRole('button', { name: 'Save definition', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Retry' }).waitFor();
  await page.evaluate(() => {
    window.globalsFixture.delay = 200;
  });
  await page.getByRole('button', { name: 'Save definition', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Save definition', exact: true }).isDisabled(),
    true,
  );
  await page.getByText('Saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Acknowledge review', exact: true }).click();
  await page.getByText('Direct · acknowledged · live', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await edit('35%');
  await page.getByRole('button', { name: 'Save definition', exact: true }).click();
  await page.getByText('Direct · required · live', { exact: true }).waitFor();
  await edit('40%');
  await page.evaluate(() => {
    window.globalsFixture.next = 'conflict';
  });
  await page.getByRole('button', { name: 'Save definition', exact: true }).click();
  await page.getByRole('button', { name: 'Reload and discard draft' }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.match(await page.locator('.cm-content').innerText(), /35%/);
  const filter = page.getByRole('searchbox', { name: 'Filter consumers' });
  await filter.fill('no-match');
  await page.getByText('No matching consumers.', { exact: false }).waitFor();
  await filter.fill('');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('DamageNew');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('heading', { name: 'DamageNew', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create global', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Empty');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page
    .getByRole('combobox', { name: 'Global entry' })
    .selectOption({ label: 'Empty · variable' });
  await page.getByText('Explicit empty variable value.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Remove', exact: true })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await page.getByRole('heading', { name: 'DamageNew', exact: true }).waitFor();
  results.push(
    'first/later selection, draft cancel/discard, URL Back/Forward, typing/save, projected impact, retry/pending/conflict/reload, acknowledgement/invalidation, filter empty/restore, rename Enter, create empty variable, and removal passed',
  );

  for (const role of ['signed-out', 'trial', 'translator', 'editor', 'maintainer']) {
    await open(role);
    assert.equal(
      await page.getByRole('button', { name: 'Create global', exact: true }).count(),
      ['trial', 'editor', 'maintainer'].includes(role) ? 1 : 0,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Rename', exact: true }).count(),
      ['editor', 'maintainer'].includes(role) ? 1 : 0,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Remove', exact: true }).count(),
      role === 'maintainer' ? 1 : 0,
    );
    if (role === 'translator') {
      await page.getByRole('button', { name: 'English source changes', exact: true }).click();
      await page.getByRole('switch', { name: 'Raw diff' }).click();
      await page.getByRole('switch', { name: 'Raw diff' }).click();
      await page.keyboard.press('Escape');
      await edit('20 %');
      await page.getByRole('button', { name: 'Save definition', exact: true }).click();
      await page.getByText('Saved', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
      await edit('Local only');
      assert.equal(
        await page.getByRole('button', { name: 'Save definition', exact: true }).isDisabled(),
        true,
      );
    }
  }
  results.push(
    'signed-out, trial, translator assigned/unassigned language, editor, and maintainer controls passed',
  );

  await page.goto(
    'http://127.0.0.1:5296/test/globals-entries.html?role=maintainer&empty=1&readFailure=1',
  );
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('No globals yet.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Create global', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('First');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('heading', { name: 'First', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove language', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Remove language', exact: true })
    .getByRole('button', { name: 'Remove language', exact: true })
    .click();
  await page.getByText('No definition in this language.', { exact: false }).waitFor();
  results.push(
    'initial read failure/retry, empty collection/create, explicit language removal, assigned translation save, and English source rendered/Raw comparison passed',
  );

  for (const width of [390, 768, 1280])
    for (const theme of ['dark', 'light'])
      for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
        await page.setViewportSize({ width, height: 900 });
        await open();
        await page.evaluate(
          ({ theme, scale }) => {
            document.documentElement.dataset.theme = theme;
            const style = document.createElement('style');
            style.textContent = `html { font-size: ${scale}% !important; }`;
            document.head.append(style);
            window.dispatchEvent(new Event('clarity-ui-scale'));
          },
          { theme, scale },
        );
        assert.equal(
          await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
          `${(16 * scale) / 100}px`,
        );
        for (const view of width === 390
          ? ['Editor', 'Usages / Translations', 'Preview']
          : ['desktop']) {
          if (view !== 'desktop')
            await page.getByRole('button', { name: view, exact: true }).click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            `overflow ${width}/${theme}/${scale}/${view}`,
          );
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-${scale}-${view.replaceAll(' / ', '-')}.png`),
            fullPage: true,
          });
        }
        if (width === 390)
          await page.getByRole('button', { name: 'Usages / Translations', exact: true }).click();
        await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
        await page.getByRole('dialog', { name: 'Review consumer impact', exact: true }).waitFor();
        await page
          .getByText('Checking Base and Enhanced rendering…', { exact: true })
          .waitFor({ state: 'hidden' });
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-${scale}-review.png`),
          fullPage: true,
        });
        await page.keyboard.press('Escape');
      }
  assert.deepEqual(errors, []);
  results.push(
    '390/768/1280, dark/light, 100/150%, phone 120%, phone views, and review popover captures passed with zero document overflow and no page errors',
  );
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(results.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
