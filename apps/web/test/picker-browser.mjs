/* global document, window */
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
    ['desktop', { width: 1920, height: 1080 }],
    ['laptop', { width: 1366, height: 768 }],
    ['phone', { width: 390, height: 844 }],
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
    if (name !== 'phone') {
      assert.equal(size.height, size.clientHeight, `${name}: collapsed document scroll`);
      const comparison = page.getByRole('region', { name: 'Sample entry' });
      const dimensions = await comparison.evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        category: node.closest('section[aria-label="Synthetic traits"]')?.getBoundingClientRect()
          .height,
      }));
      assert.ok(
        dimensions.scrollHeight > dimensions.clientHeight,
        `${name}: long comparison should scroll internally: ${JSON.stringify(dimensions)}`,
      );
    }

    await page
      .getByLabel('Owner guidance for Synthetic traits')
      .fill('Category note remains visible');
    await page.getByLabel('Note for Sample 101 (optional)').fill('Sample note remains visible');
    await page.getByRole('button', { name: 'Pick other' }).click();
    await page.getByLabel('Find row by name / section').fill('Sample 100');
    await page.getByRole('button', { name: 'Pick description cells near this name' }).click();
    const first = page.getByRole('button', { name: /^Row 100, column 2: First part/ });
    const second = page.getByRole('button', { name: 'Row 101, column 2: Second part' });
    const confirm = page.getByRole('button', { name: 'Use selected cells (local reference)' });
    await first.click();
    await second.click();
    if (name !== 'phone') {
      const sample = page.getByRole('region', { name: 'Resolve sample Sample 101' });
      await sample.evaluate((node) => {
        node.scrollTop = 0;
      });
      await sample.focus();
      await page.keyboard.press('End');
      await page.waitForFunction((node) => node.scrollTop > 0, await sample.elementHandle());
    }
    await page.getByLabel('Note for Sample 101 (optional)').click();
    await page.getByLabel('Owner guidance for Synthetic traits').click();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    assert.equal(await confirm.isDisabled(), true, `${name}: cleared selection must not confirm`);
    await first.click();
    await page.getByRole('button', { name: 'Close picker' }).click();
    assert.equal(await page.getByText('Other source selected', { exact: false }).count(), 0);

    await page.getByRole('button', { name: 'Pick other' }).click();
    await page.getByLabel('Find row by name / section').fill('Sample 100');
    await page.getByRole('button', { name: 'Pick description cells near this name' }).click();
    await first.click();
    await second.click();
    await confirm.scrollIntoViewIfNeeded();
    const centerHit = await confirm.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    });
    assert.equal(centerHit, true, `${name}: confirmation is covered`);
    await confirm.click();
    await page.getByText('Other source selected', { exact: false }).waitFor();
    await page.getByText('Chosen source description').click();
    assert.ok(await page.getByText('First part', { exact: false }).count());
    await page.getByLabel('Note for Sample 101 (optional)').click();
    await page.getByLabel('Owner guidance for Synthetic traits').click();
    await page.getByRole('button', { name: 'Pick other' }).click();
    await page.getByRole('button', { name: 'Close picker' }).click();
    assert.equal(
      await page.getByLabel('Owner guidance for Synthetic traits').inputValue(),
      'Category note remains visible',
    );
    assert.equal(
      await page.getByLabel('Note for Sample 101 (optional)').inputValue(),
      'Sample note remains visible',
    );
    const state = await page.evaluate(() => window.pickerFixture.read());
    const reference = state.document.categories['catalog:weapon-trait'].references['101'];
    assert.equal(reference.decision, 'picked');
    assert.deepEqual(reference.link.cells, [
      { dRow: 0, dCol: 1 },
      { dRow: 1, dCol: 1 },
    ]);
    assert.match(reference.link.snapshot.plain, /First part/);
    assert.match(reference.link.snapshot.plain, /Second part/);
    assert.deepEqual(state.drafts, {});
    await page.getByRole('button', { name: 'Toggle ordinary picker' }).click();
    const draft = page.getByRole('button', { name: 'Use selected cells (local draft)' });
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
    console.log(`${name}: picker pointer, cancel, reference and draft checks passed`);
  }
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
