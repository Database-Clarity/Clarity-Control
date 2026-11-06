/* global document, window, getComputedStyle, PerformanceObserver, performance */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The find & replace widget in the real shell on synthetic data: compact one-row widget top right
// of the text (nothing below it moves), a replace row behind the chevron, count, toggles, keyboard
// flows, no overflow or wrapping inside the widget, 44px targets on touch, kept across tooltips.
// Both themes, 390 / 768 / 1280, interface scale 100 and 150. Usage: node find-widget-browser.mjs
// [screenshot dir]. Timing here is on the dev server and indicative only; the gates run on a
// production build.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/ui-fixes-2a-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.FIND_WIDGET_PORT ?? 5311);
const url = `http://127.0.0.1:${port}/test/shell.html`;

process.env.VITE_API_URL = 'https://api.fixture.invalid';
const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

async function open(theme, viewport, phone, scale) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  await context.addInitScript((value) => {
    if (!localStorage.getItem('clarity-settings:device:v1'))
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
  }, scale);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate(() => {
    window.shellFixture.role('maintainer');
    window.shellFixture.variants();
  });
  await page.evaluate(() => {
    window.location.hash = '#/t/1000?lang=en';
  });
  await page.locator('.cm-content').first().waitFor();
  return { context, page, errors };
}

const widgetFacts = (page) =>
  page.evaluate(() => {
    const widget = document.querySelector('.cm-editor .cm-search');
    const editor = document.querySelector('.cm-editor').getBoundingClientRect();
    const box = widget.getBoundingClientRect();
    const controls = [...widget.querySelectorAll('button, input, .fw-count')].filter(
      (node) => node.getClientRects().length > 0,
    );
    return {
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width },
      editor: { left: editor.left, right: editor.right, top: editor.top },
      overflowX: widget.scrollWidth - widget.clientWidth,
      clipped: controls
        .filter((node) => node.scrollWidth > node.clientWidth + 1 && node.tagName !== 'INPUT')
        .map((node) => `${node.tagName}.${node.className}`),
      outside: controls
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5
          );
        })
        .map((node) => `${node.tagName}.${node.className}`),
      wrapped: controls
        .filter((node) => {
          if (node.tagName === 'INPUT' || !node.textContent.trim()) return false;
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top / 4))).size > 1;
        })
        .map((node) => `${node.tagName}.${node.className}`),
      small: controls
        .filter((node) => node.tagName !== 'SPAN')
        .map((node) => {
          const r = node.getBoundingClientRect();
          return { name: node.getAttribute('name') ?? node.className, w: r.width, h: r.height };
        })
        .filter((c) => c.h < 43.5 || (c.name !== 'search' && c.name !== 'replace' && c.w < 43.5)),
      firstLine: document.querySelector('.cm-line').getBoundingClientRect().top,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      count: widget.querySelector('.fw-count').textContent,
      fontSize: parseFloat(getComputedStyle(widget.querySelector('.fw-input')).fontSize),
    };
  });

const failures = [];
const metrics = [];
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      for (const scale of [100, 150]) {
        const label = `${theme} ${width} @${scale}`;
        const tag = `${theme}-${width}-${scale}`;
        const { context, page, errors } = await open(theme, { width, height }, phone, scale);
        await page.evaluate(() => {
          window.__long = [];
          new PerformanceObserver((list) =>
            window.__long.push(...list.getEntries().map((e) => e.duration)),
          ).observe({
            type: 'longtask',
            buffered: true,
          });
        });
        const before = await page.evaluate(
          () => document.querySelector('.cm-line').getBoundingClientRect().top,
        );
        await page.screenshot({ path: `${shots}/${tag}-0-closed.png` });
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+f');
        const widget = page.locator('.cm-editor .cm-search');
        await widget.waitFor();
        const check = (facts, step) => {
          const where = `${label} ${step}`;
          const problems = [];
          if (facts.pageOverflow > 0) problems.push(`page scrolls by ${facts.pageOverflow}`);
          if (facts.overflowX > 0) problems.push(`widget overflows by ${facts.overflowX}`);
          if (facts.clipped.length) problems.push(`clipped ${facts.clipped}`);
          if (facts.outside.length) problems.push(`outside ${facts.outside}`);
          if (facts.wrapped.length) problems.push(`wrapped ${facts.wrapped}`);
          if (facts.box.left < facts.editor.left || facts.box.right > facts.editor.right + 0.5)
            problems.push('widget leaves the editor');
          if (Math.abs(facts.firstLine - before) > 0.5)
            problems.push(`text moved ${facts.firstLine - before}`);
          if (phone && facts.small.length)
            problems.push(`small targets ${JSON.stringify(facts.small)}`);
          if (phone && facts.fontSize < 16) problems.push(`input font ${facts.fontSize}`);
          if (problems.length) failures.push(`${where}: ${problems.join('; ')}`);
        };
        check(await widgetFacts(page), 'open');
        await page.screenshot({ path: `${shots}/${tag}-1-open.png` });

        await page.locator('input[name=search]').fill('damage');
        await page.waitForFunction(() =>
          /of \d+/.test(document.querySelector('.fw-count').textContent),
        );
        let facts = await widgetFacts(page);
        check(facts, 'query');
        if (!/^(\?|\d+) of \d+/.test(facts.count)) failures.push(`${label}: count ${facts.count}`);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() =>
          /^\d+ of /.test(document.querySelector('.fw-count').textContent),
        );
        await page.screenshot({ path: `${shots}/${tag}-2-query.png` });

        await page.locator('button[name=toggleReplace]').click();
        await page.locator('input[name=replace]').fill('DMG');
        await page.locator('button[name=case]').click();
        await page.locator('button[name=re]').click();
        facts = await widgetFacts(page);
        check(facts, 'replace row');
        await page.screenshot({ path: `${shots}/${tag}-3-replace.png` });

        // Kept across tooltips: the same widget, query and replace row, no remount.
        const mounted = await page.evaluate(() => {
          window.__widget = document.querySelector('.cm-search');
        });
        void mounted;
        await page.evaluate(() => {
          window.location.hash = '#/t/1001?lang=en';
        });
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent);
        await page.waitForFunction(() =>
          /of \d+|No results/.test(document.querySelector('.fw-count').textContent),
        );
        const kept = await page.evaluate(() => ({
          same: window.__widget === document.querySelector('.cm-search'),
          search: document.querySelector('input[name=search]').value,
          replace: document.querySelector('input[name=replace]').value,
          rowOpen: document.querySelector('.cm-search').dataset.replace,
        }));
        if (!kept.same) failures.push(`${label}: widget remounted on navigation`);
        if (kept.search !== 'damage' || kept.replace !== 'DMG' || kept.rowOpen !== 'open')
          failures.push(`${label}: find state lost ${JSON.stringify(kept)}`);
        await page.screenshot({ path: `${shots}/${tag}-4-after-navigation.png` });

        // Invalid expression, then Esc: closes and the editor has focus again.
        await page.locator('input[name=search]').fill('(');
        await page.waitForFunction(
          () => document.querySelector('.fw-count').textContent === 'Invalid',
        );
        await page.screenshot({ path: `${shots}/${tag}-5-invalid.png` });
        await page.locator('input[name=search]').focus();
        await page.keyboard.press('Escape');
        await page.locator('.cm-editor .cm-search').waitFor({ state: 'detached' });
        const focused = await page.evaluate(() =>
          document.activeElement?.classList.contains('cm-content'),
        );
        if (!focused) failures.push(`${label}: Esc did not return focus to the editor`);
        const longTasks = await page.evaluate(() => window.__long);
        metrics.push({ label, longTasks: longTasks.filter((d) => d > 50).length });
        if (errors.length) failures.push(`${label}: page errors ${errors}`);
        await context.close();
      }
    }
  }

  // Ctrl+H, keyboard flows, and timing (dev server: indicative) at 1280 / 100.
  const { context, page, errors } = await open('dark', { width: 1280, height: 800 }, false, 100);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+h');
  await page.locator('.cm-search[data-replace=open]').waitFor();
  const focusedReplace = await page.evaluate(() => document.activeElement?.getAttribute('name'));
  if (focusedReplace !== 'replace') failures.push(`Ctrl+H focused ${focusedReplace}`);
  // A narrow column (a desktop editor squeezed beside two panes): the container query stacks it.
  await page.evaluate(() => {
    document.querySelector('.cm-search').style.width = '17rem';
  });
  const narrow = await widgetFacts(page);
  const narrowProblems = [
    narrow.overflowX > 0 && `overflow ${narrow.overflowX}`,
    narrow.clipped.length && `clipped ${narrow.clipped}`,
    narrow.outside.length && `outside ${narrow.outside}`,
    narrow.wrapped.length && `wrapped ${narrow.wrapped}`,
  ].filter(Boolean);
  if (narrowProblems.length) failures.push(`narrow column: ${narrowProblems.join('; ')}`);
  await page.screenshot({ path: `${shots}/dark-1280-100-6-narrow-column.png` });
  await page.evaluate(() => {
    document.querySelector('.cm-search').style.width = '';
  });
  await page.evaluate(() => {
    window.__events = [];
    new PerformanceObserver((list) =>
      window.__events.push(
        ...list.getEntries().map((e) => ({ name: e.name, duration: e.duration })),
      ),
    ).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    });
  });
  await page.locator('input[name=search]').focus();
  await page.keyboard.type('damage', { delay: 60 });
  await page.waitForTimeout(200);
  const typing = await page.evaluate(() => window.__events.filter((e) => e.name === 'keydown'));
  metrics.push({ label: 'find input typing keydown events >=16 ms', typing });
  await page.keyboard.press('Alt+c');
  const caseOn = await page.evaluate(() =>
    document.querySelector('button[name=case]').getAttribute('aria-pressed'),
  );
  if (caseOn !== 'true') failures.push('Alt+C did not toggle case');
  await page.keyboard.press('Shift+Enter');
  if (errors.length) failures.push(`keyboard flow errors ${errors}`);
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(metrics));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
assert.ok(true);
console.log('find widget browser checks passed');
