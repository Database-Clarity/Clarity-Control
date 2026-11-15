/* global document */
// Fixture-only loading and navigation checks against the real application.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = [
  process.env.PICKER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));
if (!executablePath) throw new Error('Set PICKER_BROWSER to an installed Chromium.');
const output = await mkdtemp(join(tmpdir(), 'clarity-alias-groups-'));
const at = '2026-11-15T00:00:00Z';
const item = (hash, name) => ({
  hash,
  name,
  icon: '',
  categoryId: 'weapon-trait',
  inGameDescription: 'Same text',
  plugCategoryHash: 100,
  isEnhanced: false,
  exotic: false,
});
const items = { 10: item(10, 'Twin'), 20: item(20, 'Twin'), 30: item(30, 'Other') };
const tooltip = (hash, text) => ({
  hash,
  text: { en: { text, updatedAt: at, updatedBy: '1' } },
  associated: [],
});
const bundle = {
  sourceCommit: 'a'.repeat(40),
  generatedAt: at,
  permissions: { users: {} },
  pushed: {},
  tooltips: { 10: tooltip(10, 'Canonical body'), 30: tooltip(30, 'import main from 20') },
  aliasGroups: {
    version: 1,
    groups: {
      10: {
        members: [10, 20],
        kind: 'S',
        basis: { name: 'Twin', categoryId: 'weapon-trait' },
        by: { id: '1', login: 'maintainer' },
        at,
      },
    },
    rejected: {},
  },
};
let browser;
let server;
try {
  await build({
    configFile: false,
    root: web,
    base: '/',
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    build: { target: 'esnext', outDir: output, emptyOutDir: false },
  });
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(output + '/') && !file.startsWith(output + '\\'))
        throw new Error('Invalid path');
      response.setHeader(
        'Content-Type',
        { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ??
          'application/octet-stream',
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [390, 768, 1280])
    for (const theme of ['dark', 'light'])
      for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        await context.addInitScript(
          ({ theme, scale }) =>
            localStorage.setItem(
              'clarity-settings:device:v1',
              JSON.stringify({ theme, uiScale: scale }),
            ),
          { theme, scale },
        );
        let malformed = false;
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (url.startsWith(origin)) return route.continue();
          let value;
          if (url.includes('/bundle.json'))
            value = malformed ? { ...bundle, aliasGroups: {} } : bundle;
          else if (url.endsWith('/categories.json'))
            value = [{ id: 'weapon-trait', label: 'Traits', group: 'Weapons', order: 1 }];
          else if (url.endsWith('/items.json')) value = items;
          else if (url.endsWith('/aliases.json') || url.endsWith('/sandboxConflicts.json'))
            value = {};
          if (value !== undefined) return route.fulfill({ json: value });
          return route.fulfill({ status: 404, body: '' });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const canonicalBody = page.getByText('Canonical body', { exact: true });
        const showCanonical = async () => {
          await canonicalBody.first().waitFor({ state: 'attached' });
          const tab = page.getByRole('tab', { name: 'Preview', exact: true });
          if (await tab.isVisible()) await tab.click();
          const toggle = page.locator('button[aria-controls="shell-left"][aria-expanded="false"]');
          if (await toggle.isVisible()) await toggle.click();
          await canonicalBody.filter({ visible: true }).first().waitFor();
        };
        await page.goto(`${origin}/#/t/20`);
        await page.waitForURL('**/#/t/10');
        await showCanonical();
        await page.reload();
        await showCanonical();
        await page.goto(`${origin}/#/t/30`);
        await showCanonical();
        await page.goBack();
        await page.waitForURL('**/#/t/10');
        await page.goForward();
        await page.waitForURL('**/#/t/30');
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        assert.equal(overflow, false, `${width}/${theme}/${scale}: horizontal overflow`);
        // The phone Find sheet closes on selection; reopen it for each query.
        const finder = page.getByRole('combobox', { name: 'Tooltip', exact: true });
        const openSearch = async () => {
          if (!(await finder.isVisible())) await page.locator('[data-tooltip-finder]').click();
          await finder.waitFor();
        };
        await openSearch();
        await finder.fill('20');
        const result = page.getByRole('option').filter({ hasText: 'Twin' });
        await result.first().waitFor();
        assert.equal(await result.count(), 1);
        await finder.press('Enter');
        await page.waitForURL('**/#/t/10');
        await openSearch();
        await finder.fill('no-match');
        await page.getByText(/No tooltips match/).waitFor();
        await finder.press('Escape');
        assert.match(page.url(), /#\/t\/10$/);
        await openSearch();
        await finder.fill('20');
        await result.first().click();
        if (await finder.isVisible()) await finder.blur();
        malformed = true;
        await page.reload();
        await page
          .getByText(/Invalid input/)
          .first()
          .waitFor();
        malformed = false;
        await page.reload();
        await showCanonical();
        assert.deepEqual(errors, [], `${width}/${theme}/${scale}: page errors`);
        console.log(
          `PASS ${width}/${theme}/${scale}: load, reload, imports, history, error, and restore`,
        );
        await context.close();
      }
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
