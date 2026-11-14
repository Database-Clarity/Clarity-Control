import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';
const warnings = async (page, count) => {
  await page.waitForFunction((expected) => document.querySelectorAll('.clarity-validation-warning').length === expected, count);
  assert.equal(await page.locator('.clarity-validation-warning').count(), count);
};
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.PICKER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('Set PICKER_BROWSER to installed Chromium.');
const output = await mkdtemp(join(tmpdir(), 'clarity-glyph-'));
const evidence = process.env.GLYPH_BROWSER_OUTPUT;
let browser;
try {
  await build({
    configFile: false,
    root: web,
    base: './',
    logLevel: 'error',
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: join(web, 'test', 'glyph-warning.html') },
    },
  });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking'],
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    await page.route(/^https?:/, (route) => route.abort());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(join(output, 'test', 'glyph-warning.html')).href);
    const content = page.getByRole('textbox', { name: 'Clarity markup' });
    await content.waitFor();
    await warnings(page, 4);
    await page.getByText('Save review warnings (saving allowed)', { exact: true }).click();
    if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
    const original = await content.innerText();
    await page.getByRole('button', { name: '4 character warnings', exact: true }).click();
    await page
      .getByRole('button', { name: 'Replace first U+1F81A with <arrow/>', exact: true })
      .click();
    assert.equal(await page.locator('[data-symbol="arrow"]').count(), 1);
    assert.ok((await content.innerText()).includes('🠚'));
    await warnings(page, 3);
    // The second glyph is inside a wrapper and has an absolute offset beyond the first one.
    await page
      .getByRole('button', { name: 'Replace first U+1F81A with <arrow/>', exact: true })
      .click();
    assert.equal(await page.locator('[data-symbol="arrow"]').count(), 2);
    assert.ok(!(await content.innerText()).includes('🠚'));
    await warnings(page, 2);
    await page.keyboard.press('Control+z');
    await warnings(page, 3);
    await page.keyboard.press('Control+z');
    assert.equal(await content.innerText(), original);
    await warnings(page, 4);
    await content.press('Control+End');
    await page.keyboard.insertText(' 😀');
    await page.locator('.clarity-validation-warning').nth(4).waitFor();
    await warnings(page, 5);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Glyph browser checks passed: desktop/mobile highlights, live typing, replacement, undo, save warnings; network blocked.',
  );
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
