/* global document, window */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';

// Save validation in a local production build with a fake API (nothing real is written):
// 1. Compendium tab: Confirm on an entry with no English text drafts a link, and saving it works.
// 2. A batch where one tooltip drops a block another (unchanged-text) tooltip imports is blocked
//    and the review shows the error; the fake server receives nothing.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LINK_SAVE_PORT ?? 5316);
process.env.VITE_API_URL = 'https://api.fixture.invalid';
const output = await mkdtemp(join(tmpdir(), 'clarity-link-save-'));
let server;
let browser;
try {
  await build({
    configFile: false,
    root: web,
    base: './',
    logLevel: 'error',
    worker: { format: 'es' },
    plugins: [
      {
        name: 'fixture-proposals',
        load(id) {
          if (
            id
              .replaceAll(String.fromCharCode(92), '/')
              .endsWith('/features/compendium/useProposals.ts')
          )
            return 'export function useProposals() { return { proposals: window.__linkSaveProposals, loading: false, error: null }; }';
        },
      },
    ],
    build: {
      target: 'esnext',
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: join(web, 'test', 'link-save.html') },
    },
  });
  server = await preview({
    configFile: false,
    root: web,
    build: { outDir: output },
    preview: { host: '127.0.0.1', port, strictPort: true },
  });
  browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const open = async (hash = '') => {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/link-save.html${hash}`);
    return { page, errors };
  };
  const reviewDrafts = async (page) => {
    await page.locator('[data-drafts-button]').click();
    await page.getByRole('dialog', { name: 'Drafts' }).waitFor();
    await page.locator('[data-drafts-review]').click();
  };

  // 1. Compendium Confirm on an empty-English entry, then save.
  {
    const { page, errors } = await open();
    const confirm = page.getByRole('button', { name: /^Confirm/ });
    await confirm.waitFor();
    assert.equal(await confirm.isEnabled(), true, 'Confirm is enabled on the empty-English entry');
    await confirm.click();
    await reviewDrafts(page);
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.waitFor();
    if (!(await save.isEnabled()))
      console.log('DIALOG', await page.getByRole('dialog').last().innerText());
    assert.equal(await save.isEnabled(), true, 'a link-only change on empty English can be saved');
    assert.equal(await page.getByText('must not be empty').count(), 0);
    await save.click();
    await page.waitForFunction(() => window.linkSave.saves.length === 1);
    const saved = await page.evaluate(() => window.linkSave.saves[0]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].hash, 100);
    assert.equal(saved[0].next.compendium.rowKey, 'Sample 100');
    assert.deepEqual(errors, []);
    console.log('PASS 1: Confirm on empty English drafts a link and the save is sent');
  }

  // 2. A sibling change removes the block an unchanged tooltip imports: blocked, error shown.
  {
    const { page, errors } = await open();
    await page.getByRole('button', { name: /^Confirm/ }).waitFor();
    await page.evaluate(() => window.linkSave.draftBatchRemovingImport());
    await reviewDrafts(page);
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true, 'the save is blocked');
    await page.getByText('Unresolved import "foo" from 120.').first().waitFor();
    assert.equal(await page.evaluate(() => window.linkSave.saves.length), 0);
    assert.deepEqual(errors, []);
    console.log('PASS 2: removing a used import in the batch blocks the save with the error shown');
  }

  // 3. State sweep for the editor's empty-English diagnostic (same rule as saving).
  {
    const { page, errors } = await open('#/t/100?lang=en');
    const goto = async (hash) => {
      await page.evaluate((value) => {
        window.location.hash = `#/t/${value}?lang=en`;
      }, hash);
      await page
        .locator('.cm-content')
        .first()
        .waitFor({ timeout: 8000 })
        .catch(async (error) => {
          console.log('URL', page.url(), (await page.locator('body').innerText()).slice(0, 600));
          throw error;
        });
      await page.waitForTimeout(400);
    };
    // The status bar's issue count turns to an error when a blocking diagnostic exists (the only
    // error an English-text-only fixture can raise is the empty-English one).
    const flagged = () =>
      page.evaluate(
        () =>
          document.querySelectorAll('[data-editor-status] button[data-severity="error"]').length >
          0,
      );
    const set = async (value) => {
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+A');
      if (value) await page.keyboard.insertText(value);
      else await page.keyboard.press('Delete');
      await page.waitForTimeout(400);
    };
    await goto(100);
    assert.equal(await flagged(), false, 'untouched empty English shows no error');
    await set('Typed');
    assert.equal(await flagged(), false, 'typing over empty English shows no error');
    await set('');
    assert.equal(await flagged(), false, 'clearing back to the saved empty text shows no error');
    await set('  ');
    assert.equal(await flagged(), true, 'edited to blank shows the error');
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(400);
    assert.equal(await flagged(), false, 'undo back to the saved text clears it');
    await goto(121);
    assert.equal(await flagged(), false, 'written English shows no error');
    await set('');
    assert.equal(await flagged(), true, 'clearing written English shows the error');
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(400);
    assert.equal(await flagged(), false, 'undo restores the text and clears the error');
    await set('');
    await goto(100);
    assert.equal(await flagged(), false, 'stepping away to an untouched empty tooltip is quiet');
    await goto(121);
    assert.equal(await flagged(), true, 'stepping back to the cleared draft shows the error again');
    assert.deepEqual(errors, []);
    console.log('PASS 3: editor empty-English diagnostic follows the edited-text rule');
  }
  // 4. A recovered draft keeps its own base: empty English that was never edited stays quiet even
  // though the catalogue now has English text (the save rule compares with the draft's base).
  {
    const { page, errors } = await open('#/t/101?lang=en');
    await page.locator('.cm-content').first().waitFor();
    await page.evaluate(() => window.linkSave.staleBaseDraft());
    await page.evaluate(() => {
      window.location.hash = '#/t/102?lang=en';
    });
    await page.locator('.cm-content').first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelectorAll('[data-editor-status] button[data-severity="error"]').length,
      ),
      0,
      'a draft with an empty base shows no empty-English error',
    );
    assert.deepEqual(errors, []);
    console.log('PASS 4: recovered draft uses its own base for the empty-English diagnostic');
  }
  // 5. An item with no saved tooltip: Confirm drafts the link, the review refuses the save and
  // says why in plain words; the editor shows no empty-English error for it.
  {
    const { page, errors } = await open('#/compendium?hash=103');
    const confirm = page.getByRole('button', { name: /^Confirm/ });
    await confirm.waitFor();
    await confirm.click();
    await reviewDrafts(page);
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true, 'a link on an item without a tooltip is refused');
    await page.getByText('This item has no tooltip yet.').first().waitFor();
    assert.equal(await page.getByText('must not be empty').count(), 0);
    assert.equal(await page.evaluate(() => window.linkSave.saves.length), 0);
    assert.deepEqual(errors, []);
    console.log('PASS 5: item without a saved tooltip is refused with a plain explanation');
  }
  // 6. Only the donor is drafted. Validation still names and protects its saved dependent.
  {
    const { page, errors } = await open();
    await page.getByRole('button', { name: /^Confirm/ }).waitFor();
    await page.evaluate(() => window.linkSave.draftBatchRemovingImport(true));
    await reviewDrafts(page);
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true, 'an outside dependent blocks the save');
    await page.getByText('Dependent tooltip "User 121" (121)', { exact: false }).first().waitFor();
    assert.equal(await page.evaluate(() => window.linkSave.saves.length), 0);
    assert.deepEqual(errors, []);
    console.log('PASS 6: an outside dependent blocks the save, with its name shown');
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(output, { recursive: true, force: true });
}
