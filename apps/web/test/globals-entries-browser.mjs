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
  const completeSync = async () => {
    await page.evaluate(() => {
      window.globalsFixture.syncOutcome = 'current';
    });
    await page.getByRole('button', { name: 'Refresh sync', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^Current$/ })
      .waitFor();
  };
  const action = async (name) => {
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
  };
  await open();
  await page.evaluate(() => {
    window.globalsFixture.next = 'retry';
  });
  await page.getByRole('button', { name: 'Refresh sync' }).click();
  await page.getByRole('alert').filter({ hasText: 'Retry' }).waitFor();
  await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
  assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Refresh sync' }).click();
  await edit('25%');
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).click();
  await page.getByText('Projected impact — unsaved', { exact: true }).waitFor();
  await page.getByText('Direct, projected, Saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
  assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  await page.getByText('Gain 25% damage.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('g_title00001');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.match(await page.locator('.cm-content').innerText(), /25%/);
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Global entry' })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('g_title00001');
  await page.getByRole('button', { name: 'Discard and continue' }).click();
  await page.getByRole('heading', { name: 'Reload', exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: 'Damage', exact: true }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Reload', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Global entry' }).selectOption('g_damage0001');
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
  await page
    .getByRole('status')
    .filter({ hasText: /^Sync pending$/ })
    .waitFor();
  await page.getByText('is blocked until sync finishes.', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
  assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Acknowledge review' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.globalsFixture.syncOutcome = 'sync-failed';
  });
  await page.getByRole('button', { name: 'Refresh sync' }).click();
  await page
    .getByText('Fixture sync failed: source changed during calculation.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /^Sync pending$/ })
    .waitFor();
  await completeSync();
  await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Acknowledge review', exact: true }).click();
  await page.getByText('Direct, acknowledged, Live', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await edit('35%');
  await page.getByRole('button', { name: 'Save definition', exact: true }).click();
  await completeSync();
  await page.getByText('Direct, required, Live', { exact: true }).waitFor();
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
  await action('Rename');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('DamageNew');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('heading', { name: 'Damage', exact: true }).waitFor();
  await page.getByText('Rename queued; not complete.', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'rename-queued-1280.png'), fullPage: true });
  await completeSync();
  await page.getByRole('heading', { name: 'DamageNew', exact: true }).waitFor();
  await action('Create global');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Empty');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page
    .getByRole('combobox', { name: 'Global entry' })
    .selectOption({ label: 'Empty · variables' });
  await page.getByText('Explicit empty variable value.', { exact: true }).waitFor();
  await action('Remove');
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
    if (['trial', 'editor', 'maintainer'].includes(role))
      await page.getByRole('button', { name: 'Actions', exact: true }).click();
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
    await page.keyboard.press('Escape');
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
  await action('Create global');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('First');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('heading', { name: 'First', exact: true }).waitFor();
  await action('Remove language');
  await page
    .getByRole('dialog', { name: 'Remove language', exact: true })
    .getByRole('button', { name: 'Remove language', exact: true })
    .click();
  await page.getByText('No definition in this language.', { exact: false }).waitFor();
  await action('Remove');
  await page
    .getByRole('dialog', { name: 'Remove', exact: true })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await page.getByText('No globals yet.', { exact: false }).waitFor();
  results.push(
    'initial read failure/retry, empty collection/create, explicit language removal, assigned translation save, and English source rendered/Raw comparison passed',
  );

  await page.goto('http://127.0.0.1:5296/test/globals-entries.html?unproven=1');
  await page.getByText('Exact dependency path unavailable.', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'Open consumer', exact: true }).getAttribute('href'),
    '#/t/20?lang=fr&variant=21',
  );
  results.push(
    'unknown S1 import path/line/directness stays unavailable and never fabricates a highlighted line',
  );

  await page.goto('http://127.0.0.1:5296/test/globals-entries.html?sync=sync-failed');
  await page.locator('.cm-content').waitFor();
  await edit('28%');
  await page.getByRole('button', { name: 'Retry sync' }).click();
  assert.match(await page.locator('.cm-content').innerText(), /28%/);
  await completeSync();
  assert.match(await page.locator('.cm-content').innerText(), /28%/);
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'Reservoir Burst (French)', exact: true }).click();
  await page.getByRole('button', { name: 'Review Reservoir Burst', exact: true }).click();
  assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Acknowledge review' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.goto('http://127.0.0.1:5296/test/globals-entries.html?largeProjection=1');
  await page.locator('.cm-content').waitFor();
  await edit('50%');
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel calculation', exact: true }).waitFor();
  assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'true');
  await page.getByRole('button', { name: 'Cancel calculation', exact: true }).click();
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).click();
  await edit('51%');
  await page.getByRole('button', { name: 'Calculate projected impact', exact: true }).waitFor();
  assert.equal(await page.getByText('Direct, projected, Saved', { exact: true }).count(), 0);
  results.push(
    'Sync pending -> failed/last failure -> Retry -> pending -> current, publication block, retained drafts, stale/pending acknowledgement refusal, real browser Worker projection, explicit cancellation, and cancellation on typing passed',
  );

  // Exact trigger return, safe initial focus, and contained keyboard order.
  await open();
  const actions = page.getByRole('button', { name: 'Actions', exact: true });
  const focused = async (locator) =>
    assert.equal(await locator.evaluate((node) => document.activeElement === node), true);
  await actions.focus();
  await page.keyboard.press('Enter');
  await focused(page.getByRole('button', { name: 'Create global', exact: true }));
  await page.keyboard.press('Tab');
  await focused(page.getByRole('button', { name: 'Rename', exact: true }));
  await page.keyboard.press('Enter');
  await focused(page.getByRole('button', { name: 'Cancel', exact: true }));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focused(actions);
  await actions.press('Enter');
  await page.keyboard.press('Escape');
  await focused(actions);
  await action('Remove');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focused(actions);
  const review = page.getByRole('button', { name: 'Review Focused Fury', exact: true });
  await review.click();
  await page.keyboard.press('Escape');
  await focused(review);
  await review.click();
  const preview = page.getByRole('button', { name: 'Preview definition', exact: true });
  await preview.click();
  await page.getByRole('dialog', { name: 'Definition preview', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('dialog', { name: 'Review consumer impact', exact: true }).count(),
    0,
  );
  await focused(preview);
  await page.keyboard.press('Escape');
  await focused(preview);
  results.push(
    'Keyboard Actions -> Create -> Rename, safe Cancel autofocus, Cancel/Escape/outside dismissal, and exact Actions/review/preview trigger focus return passed',
  );

  await page.goto('http://127.0.0.1:5296/test/globals-entries.html?largeList=1');
  await page.locator('[data-global-consumer]').last().waitFor();
  const list = page.locator('ul').filter({ has: page.locator('[data-global-consumer]') });
  const editorBefore = await page.locator('.cm-content').boundingBox();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await list.hover();
  await page.mouse.wheel(0, 1200);
  await page.waitForFunction(
    () => document.querySelector('[data-global-consumer]').parentElement.scrollTop > 0,
  );
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  assert.equal((await page.locator('.cm-content').boundingBox()).y, editorBefore.y);
  const far = page.getByRole('button', { name: 'Focused Fury consumer 80 (English)', exact: true });
  await far.click();
  assert.ok((await list.evaluate((node) => node.scrollTop)) > 0);
  await page.getByRole('button', { name: 'Review Focused Fury consumer 80', exact: true }).click();
  await page.keyboard.press('Escape');
  await focused(page.getByRole('button', { name: 'Review Focused Fury consumer 80', exact: true }));
  await page.getByRole('searchbox', { name: 'Filter consumers' }).fill('missing');
  await page.getByText('No matching consumers.', { exact: false }).waitFor();
  await page.getByRole('searchbox', { name: 'Filter consumers' }).fill('');
  await far.click();
  const selectedScroll = await list.evaluate((node) => node.scrollTop);
  assert.ok(selectedScroll > 0);
  await page.goBack();
  await page.goForward();
  assert.equal(await list.evaluate((node) => node.scrollTop), selectedScroll);
  await page.screenshot({ path: resolve(output, '1280-large-list.png'), fullPage: true });
  results.push(
    '82 consumers: wheel scroll stays in list, editor/page stay fixed, far-row selection/review, filter empty/restore, and Back/Forward list scroll restoration passed',
  );

  const checkLayout = async (context) => {
    const failures = await page.evaluate(() => {
      const failures = [];
      const visible = (node) => node && node.getClientRects().length > 0;
      const box = (node) => node.getBoundingClientRect();
      const header = document.querySelector('article > header');
      if (
        header &&
        [...header.children].some(
          (node) =>
            Math.abs(box(node).y + box(node).height / 2 - box(header).y - box(header).height / 2) >
            2,
        )
      )
        failures.push('header alignment');
      const selection = [...document.querySelectorAll('article > div > label > select')].filter(
        visible,
      );
      if (
        window.innerWidth === 390 &&
        selection.length === 2 &&
        (Math.abs(box(selection[0]).x - box(selection[1]).x) > 1 ||
          Math.abs(box(selection[0]).width - box(selection[1]).width) > 1)
      )
        failures.push('selection columns');
      const filters = [...document.querySelectorAll('select')].filter(
        (node) =>
          visible(node) &&
          ['Category', 'Language', 'Review'].includes(
            node.closest('label')?.textContent.replace(/All.*/, '').trim(),
          ),
      );
      if (
        filters.length === 3 &&
        filters.some((node) => Math.abs(box(node).bottom - box(filters[0]).bottom) > 1)
      )
        failures.push('filter baselines');
      const save = [...document.querySelectorAll('button')].find(
        (node) => node.textContent === 'Save definition',
      );
      const discard = [...document.querySelectorAll('button')].find(
        (node) => node.textContent === 'Discard draft',
      );
      if (visible(save) && visible(discard) && Math.abs(box(save).y - box(discard).y) > 1)
        failures.push('save/discard row');
      for (const button of document.querySelectorAll('button')) {
        if (
          !visible(button) ||
          !button.textContent.trim() ||
          (button.closest('[data-global-consumer]') && button.getAttribute('aria-pressed') !== null)
        )
          continue;
        if (button.scrollWidth > button.clientWidth + 1)
          failures.push(`clipped control: ${button.textContent}`);
      }
      return failures;
    });
    assert.deepEqual(failures, [], context);
  };

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
        for (const view of width === 390 ? ['Editor', 'Usages', 'Preview'] : ['desktop']) {
          if (view !== 'desktop')
            await page.getByRole('button', { name: view, exact: true }).click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            `overflow ${width}/${theme}/${scale}/${view}`,
          );
          await checkLayout(`${width}/${theme}/${scale}/${view}`);
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-${scale}-${view.replaceAll(' / ', '-')}.png`),
            fullPage: true,
          });
        }
        await actions.click();
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-${scale}-actions.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Rename', exact: true }).click();
        await focused(page.getByRole('button', { name: 'Cancel', exact: true }));
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-${scale}-rename.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await focused(actions);
        if (width === 390) await page.getByRole('button', { name: 'Usages', exact: true }).click();
        await page.getByRole('button', { name: 'Review Focused Fury', exact: true }).click();
        await page.getByRole('dialog', { name: 'Review consumer impact', exact: true }).waitFor();
        await page
          .getByText('Checking Base and Enhanced rendering…', { exact: true })
          .waitFor({ state: 'hidden' });
        const rawBox = await page.getByRole('switch', { name: 'Raw diff' }).boundingBox();
        const popupBox = await page
          .getByRole('dialog', { name: 'Review consumer impact', exact: true })
          .boundingBox();
        assert.ok(rawBox.width < popupBox.width / 2, 'compact Raw switch');
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-${scale}-review.png`),
          fullPage: true,
        });
        await page.keyboard.press('Escape');
        await focused(page.getByRole('button', { name: 'Review Focused Fury', exact: true }));
        await page.getByRole('button', { name: 'Translations', exact: true }).click();
        await page.getByRole('heading', { name: 'English source', exact: true }).waitFor();
        await checkLayout(`${width}/${theme}/${scale}/translations`);
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-${scale}-translations.png`),
          fullPage: true,
        });
        for (const status of ['sync-pending', 'sync-failed']) {
          await page.goto(`http://127.0.0.1:5296/test/globals-entries.html?sync=${status}`);
          await page.locator('.cm-content').waitFor();
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
          if (width === 390)
            await page.getByRole('button', { name: 'Usages', exact: true }).click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            `overflow ${width}/${theme}/${scale}/${status}`,
          );
          await checkLayout(`${width}/${theme}/${scale}/${status}`);
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-${scale}-${status}.png`),
            fullPage: true,
          });
        }
      }
  await page.setViewportSize({ width: 390, height: 900 });
  await open();
  await page.evaluate(() => document.documentElement.style.setProperty('--tap', '44px'));
  assert.ok((await actions.boundingBox()).height >= 44);
  await action('Rename');
  assert.ok(
    (await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).height >= 44,
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  results.push('Large touch preference keeps the 44px floor on header and confirmation controls');
  assert.deepEqual(errors, []);
  results.push(
    '390/768/1280, dark/light, 100/150%, phone 120%, phone views, pending/failed sync states, and review popover captures passed with zero document overflow and no page errors',
  );
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(results.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
