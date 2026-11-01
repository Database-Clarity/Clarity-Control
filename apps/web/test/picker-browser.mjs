/* global document, window, Node */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.PICKER_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));
if (!browserPath)
  throw new Error('Set PICKER_BROWSER to an installed Chromium browser executable.');

const output = await mkdtemp(join(tmpdir(), 'clarity-picker-regression-'));
let browser;
try {
  await build({
    configFile: false,
    root: web,
    base: './',
    logLevel: 'error',
    build: {
      target: 'esnext',
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: join(web, 'test', 'picker-browser.html') },
    },
  });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking'],
  });
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
    ['short-phone', { width: 390, height: 500 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const network = [];
    await context.route(/^https?:/, async (route) => {
      network.push(route.request().url());
      await route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(output, 'test', 'picker-browser.html')).href);
    await page.getByRole('heading', { name: 'Synthetic traits' }).waitFor();
    const size = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
    }));
    assert.equal(size.width, size.clientWidth, `${name}: horizontal document overflow`);
    const phone = viewport.width === 390;
    const owner = page.getByText('Owner guidance for Synthetic traits', { exact: true }).first();
    const note = page.getByText('Example note', { exact: true });
    await owner.click();
    await page.getByLabel('Owner guidance for Synthetic traits').fill('Category note retained');
    await note.click();
    await page.getByLabel('Note for Sample 101 (optional)').fill('Sample note retained');
    await note.click();
    await owner.click();
    const pick = page.getByRole('button', { name: 'Pick other' });
    await pick.click();
    const dialog = page.getByRole('dialog', { name: 'Choose Compendium source' });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
    const modalSize = await dialog.evaluate((node) => ({
      width: node.scrollWidth,
      client: node.clientWidth,
      height: node.getBoundingClientRect().height,
    }));
    assert.equal(modalSize.width, modalSize.client, `${name}: picker horizontal overflow`);
    if (phone) assert.equal(modalSize.height, viewport.height);
    const controlsFirst = await dialog.evaluate((node) => {
      const search = node.querySelector('input');
      const rationale = [...node.querySelectorAll('summary')].find((el) =>
        el.textContent.includes('Why these'),
      );
      return (
        !!(search.compareDocumentPosition(rationale) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !rationale.parentElement.open
      );
    });
    assert.equal(controlsFirst, true);
    const backgroundBefore = await page.evaluate(() => JSON.stringify(window.pickerFixture.read()));
    await page.keyboard.press('a');
    await page.keyboard.press('s');
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.pickerFixture.read())),
      backgroundBefore,
    );
    await page.getByLabel('Find row by name / section').fill('Sample 100');
    await page.getByRole('button', { name: 'Pick description cells near this name' }).click();
    const first = () =>
      page.getByRole('button', { name: /^Row 100, column 2(?: \(\d+\))?: First part/ });
    const second = () =>
      page.getByRole('button', { name: /^Row 101, column 2(?: \(\d+\))?: Second part/ });
    async function selectCell(locator) {
      await locator.click();
      if (phone) {
        await page.getByRole('region', { name: 'Cell detail' }).waitFor();
        await page.getByRole('button', { name: 'Select cell next' }).click();
        await page.getByRole('button', { name: 'Back to cells' }).click();
        assert.equal(
          await locator.evaluate((node) => document.activeElement === node),
          true,
          'detail Back restores cell focus',
        );
      }
    }
    // Author order deliberately differs from sheet order.
    await selectCell(second());
    await selectCell(first());
    await page.getByLabel('Compendium tab').selectOption('other-sheet');
    await page.getByLabel('Compendium tab').selectOption('1662574278');
    await page.getByRole('button', { name: 'Pick description cells near this name' }).click();
    const confirm = page.getByRole('button', { name: 'Use selected cells (local reference)' });
    assert.equal(await confirm.isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await pick.evaluate((node) => document.activeElement === node), true);
    await pick.click();
    assert.equal(await confirm.isEnabled(), true, 'Back retains selection');
    if (phone) {
      const targets = await dialog
        .locator('button:visible, select:visible, input:visible, summary:visible')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            text: node.textContent?.slice(0, 50),
            height: node.getBoundingClientRect().height,
          })),
        );
      assert.deepEqual(
        targets.filter((node) => node.height < 44),
        [],
        `${name}: short targets`,
      );
      const beforeWheel = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 600);
      assert.equal(await page.evaluate(() => window.scrollY), beforeWheel, 'modal owns scrolling');
    }
    // Native Tab containment at both ends.
    await dialog.getByRole('button', { name: 'Back', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
    await confirm.click();
    await page.getByText('Other source selected', { exact: false }).waitFor();
    await owner.click();
    await note.click();
    assert.equal(
      await page.getByLabel('Owner guidance for Synthetic traits').inputValue(),
      'Category note retained',
    );
    assert.equal(
      await page.getByLabel('Note for Sample 101 (optional)').inputValue(),
      'Sample note retained',
    );
    await page.getByLabel('Note for Sample 101 (optional)').scrollIntoViewIfNeeded();
    const actions = page
      .getByRole('region', { name: 'Resolve sample Sample 101' })
      .getByRole('button');
    if (phone) {
      for (const label of ['Accept proposed link', 'Pick other', 'No equivalent', 'Skip']) {
        const rect = await actions.filter({ hasText: label }).first().boundingBox();
        assert.ok(
          rect.height >= 44 && rect.y >= 0 && rect.y + rect.height <= viewport.height,
          `${name}: decision ${label} reachable ${JSON.stringify(rect)}`,
        );
      }
    }
    const state = await page.evaluate(() => window.pickerFixture.read());
    const reference = state.document.categories['catalog:weapon-trait'].references['101'];
    assert.equal(reference.decision, 'picked');
    assert.deepEqual(reference.link.cells, [
      { dRow: 1, dCol: 1 },
      { dRow: 0, dCol: 1 },
    ]);
    assert.match(reference.link.snapshot.plain, /First part/);
    assert.match(reference.link.snapshot.plain, /Second part/);
    assert.deepEqual(state.drafts, {});
    await page.getByRole('button', { name: 'Toggle ordinary picker' }).click();
    const draft = page.getByRole('button', { name: 'Use selected cells (local draft)' });
    await page.getByLabel('Find row by name / section').fill('Sample 100');
    await page.getByRole('button', { name: 'Pick description cells near this name' }).click();
    await draft.waitFor();
    assert.equal(
      await draft.isDisabled(),
      true,
      `${name}: signed-out draft selection must stay gated`,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Use selected cells (local reference)' }).count(),
      0,
    );
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `${name}: modal, focus, order, retention, geometry, sticky actions and draft gates passed`,
    );
  }
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
