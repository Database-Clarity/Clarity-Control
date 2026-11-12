/* global document, window */
// Render QA for the Sandbox perks worklist (/sandbox-perks) on real generator and bundle data,
// with a stubbed maintainer API: no horizontal overflow, no clipped or wrapped controls, rows
// that fit their fixed height, at 390/768/1280 in both themes and UI scale 100/120/150, plus the
// long tasks of opening the page, switching filters, expanding a row, and the bulk compiled check.
// Screenshots: SANDBOX_SHOTS=<dir>. Browser: PICKER_BROWSER or an installed Chrome/Edge.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.PICKER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!browserPath) throw new Error('Set PICKER_BROWSER to an installed Chromium browser.');
const shots = process.env.SANDBOX_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const api = 'https://synthetic.invalid';
const output = await mkdtemp(join(tmpdir(), 'clarity-sandbox-'));
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${b64({ id: 1, login: 'qa', exp: Math.floor(Date.now() / 1000) + 86_400 })}.sig`;
const picks = {
  revision: null,
  exporting: true,
  pointers: { version: 1, pointers: {} },
};
let browser;
const report = { cases: [], perf: [] };
try {
  // The app's own config (plugins, workers, chunking); its imports need the module runner.
  await build({
    configFile: resolve(web, 'vite.config.ts'),
    configLoader: 'runner',
    root: web,
    base: './',
    logLevel: 'error',
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(api) },
    build: { outDir: output, emptyOutDir: true },
  });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--allow-file-access-from-files'],
  });
  const open = async (width, theme, scale) => {
    const context = await browser.newContext({
      viewport: { width, height: width < 700 ? 844 : 900 },
      colorScheme: theme,
      deviceScaleFactor: 1,
    });
    await context.addInitScript((value) => {
      localStorage.setItem('clarity-editor-session', value);
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    }, token);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${api}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/me')
        return route.fulfill({ json: { id: 1, login: 'qa', role: 'maintainer', languages: [] } });
      if (url.pathname === '/sandbox-pointers') return route.fulfill({ json: picks });
      if (url.pathname === '/settings') return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ status: 404, json: { error: 'stub' } });
    });
    await page.goto(`${pathToFileURL(join(output, 'index.html')).href}#/sandbox-perks`);
    await page.waitForSelector('[data-state]', { timeout: 120_000 });
    await page.evaluate((value) => {
      const root = document.documentElement;
      const width = window.innerWidth;
      const floor = width > 700 ? 710 : 260;
      const applied =
        value <= 100 ? value : Math.max(100, Math.min(value, Math.floor((width / floor) * 100)));
      if (applied === 100) root.style.removeProperty('font-size');
      else root.style.fontSize = `${applied}%`;
      root.dataset.uiScale = String(applied);
      // No resize event: the settings store would re-apply its own (100%) scale on it.
      window.dispatchEvent(new Event('clarity-ui-scale'));
    }, scale);
    await page.waitForTimeout(150);
    return { context, page, errors };
  };
  const measure = (page) =>
    page.evaluate(() => {
      const article = document.querySelector('article');
      const lines = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      };
      const controls = [...article.querySelectorAll('button, select, input[type="search"]')].filter(
        (element) => element.getClientRects().length,
      );
      const rows = [...article.querySelectorAll('[data-state]')];
      const filterHeights = [
        ...article.querySelectorAll(
          '[aria-label="Filter sandbox perks"] > :is(input, select, button)',
        ),
      ].map((element) => Math.round(element.getBoundingClientRect().height));
      const rowButtons = rows.flatMap((row) =>
        [...row.querySelectorAll('button')].map((b) =>
          Math.round(b.getBoundingClientRect().height),
        ),
      );
      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        articleOverflow: article.scrollWidth - article.clientWidth,
        wrappedControls: controls
          .filter((element) => element.tagName === 'BUTTON' && lines(element) > 1)
          .map((element) => element.textContent),
        clippedControls: controls
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent || element.getAttribute('aria-label')),
        rowsOverflowing: rows
          .filter((row) => row.scrollHeight > row.clientHeight + 1)
          .map((row) => row.textContent.slice(0, 40)),
        rowsShown: rows.length,
        filterHeights: [...new Set(filterHeights)],
        rowButtonHeights: [...new Set(rowButtons)],
        saveBarVisible: (() => {
          const bar = [...article.querySelectorAll('button')].find((b) => b.textContent === 'Save');
          const rect = bar?.getBoundingClientRect();
          return Boolean(rect && rect.bottom <= window.innerHeight && rect.top >= 0);
        })(),
      };
    });
  const longTasks = (page) => page.evaluate(() => window.__longTasks.splice(0));

  for (const width of [390, 768, 1280])
    for (const theme of ['light', 'dark'])
      for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
        const { context, page, errors } = await open(width, theme, scale);
        const name = `${width}-${theme}-${scale}`;
        const list = await measure(page);
        if (shots) await page.screenshot({ path: join(shots, `${name}-list.png`) });
        // Expand a row (Choose) and stage a pick: the save bar shows one staged change.
        await page.locator('[data-state] button', { hasText: 'Choose' }).first().click();
        await page.locator('[data-state] input[type="radio"]').last().check();
        const expanded = await measure(page);
        if (shots) await page.screenshot({ path: join(shots, `${name}-expanded.png`) });
        report.cases.push({ name, errors, list, expanded });
        await context.close();
      }

  // Perf: one desktop run at UI 100 on real data.
  {
    const { context, page } = await open(1280, 'dark', 100);
    const opened = await longTasks(page);
    const step = async (label, action) => {
      await longTasks(page);
      const start = await page.evaluate(() => performance.now());
      await action();
      await page.waitForTimeout(300);
      const tasks = await longTasks(page);
      report.perf.push({
        label,
        longTasks: tasks.map((task) => Math.round(task.duration)),
        sinceStartMs: Math.round((await page.evaluate(() => performance.now())) - start - 300),
      });
    };
    report.perf.push({
      label: 'open page (incl. app load)',
      longTasks: opened.map((t) => Math.round(t.duration)),
    });
    await step('filter: All', () => page.selectOption('select[aria-label="Status"]', 'all'));
    await step('filter: Same text', () =>
      page.selectOption('select[aria-label="Status"]', 'same-text'),
    );
    await step('type search "a"', () => page.fill('input[type="search"]', 'a'));
    await step('clear search', () => page.fill('input[type="search"]', ''));
    await step('Choose (expand)', () =>
      page.locator('[data-state] button', { hasText: 'Choose' }).first().click(),
    );
    await step('bulk compiled check', async () => {
      await page.locator('button', { hasText: /^Apply all/ }).click();
      await page.waitForSelector('text=after the compiled check', { timeout: 120_000 });
    });
    report.bulk = await page.evaluate(
      () => document.querySelector('[role="status"] p')?.textContent,
    );
    await context.close();
  }
  const out = process.env.SANDBOX_REPORT;
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  for (const result of report.cases) {
    for (const state of ['list', 'expanded']) {
      const m = result[state];
      assert.deepEqual(result.errors, [], `${result.name}: page errors`);
      assert.ok(m.docOverflow <= 0 && m.articleOverflow <= 0, `${result.name} ${state}: overflow`);
      assert.deepEqual(m.wrappedControls, [], `${result.name} ${state}: wrapped controls`);
      assert.deepEqual(m.clippedControls, [], `${result.name} ${state}: clipped controls`);
      assert.deepEqual(
        m.rowsOverflowing,
        [],
        `${result.name} ${state}: rows overflow their height`,
      );
      assert.equal(m.filterHeights.length, 1, `${result.name} ${state}: filter controls differ`);
      assert.ok(m.saveBarVisible, `${result.name} ${state}: save bar off screen`);
    }
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
