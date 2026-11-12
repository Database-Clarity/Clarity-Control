/* global window, document, indexedDB, requestAnimationFrame, addEventListener, MutationObserver */
// Save scenario controller using the shared actor's trace capture and fixture server.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('package.json'));
const { chromium } = require('playwright-core');
const [mode, baseline, candidate, outArg, sharedArg, fixturesArg] = process.argv.slice(2);
if (![mode, baseline, candidate, outArg, sharedArg, fixturesArg].every(Boolean))
  throw Error(
    'Usage: node save-perf.mjs smoke|throttled|full baseline-dist candidate-dist output shared-harness fixture-json',
  );
const shared = resolve(sharedArg);
const out = resolve(outArg);
await mkdir(out, { recursive: true });
process.env.PERF_OUT = out;
const actorPath = shared + '/uniform-walk.mjs';
const actor = await import(pathToFileURL(actorPath));
await copyFile(actorPath, out + '/actor.mjs');
const actorSHA = createHash('sha256')
  .update(await readFile(actorPath))
  .digest('hex');
const fixture = JSON.parse(await readFile(resolve(fixturesArg), 'utf8'));
const bodies = {};
for (const name of ['categories', 'items', 'aliases', 'bundle', 'source'])
  bodies[name] = await readFile(shared + '/typing/fixtures/' + name + '.json', 'utf8');
const gen =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2/';
const urls = new Map(
  [
    ['categories', 'categories'],
    ['items', 'items'],
    ['aliases', 'aliases'],
  ].map(([name, key]) => [gen + name + '.json', bodies[key]]),
);
urls.set(
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json',
  bodies.bundle,
);
urls.set(
  'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json',
  bodies.source,
);
const browser = await chromium.launch({
  ...(process.env.PERF_BROWSER ? { executablePath: process.env.PERF_BROWSER } : {}),
  headless: true,
});
const results = [];
try {
  for (const [arm, dist] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    process.argv[2] = resolve(dist);
    process.argv[3] = '0';
    const { server } = await import(
      pathToFileURL(shared + '/typing/server.mjs').href + '?arm=' + arm
    );
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      for (const rate of mode === 'smoke' ? [1] : mode === 'throttled' ? [4] : [1, 4])
        for (const kind of ['single', 'batch']) {
          const changes = fixture[kind];
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
          const errors = [];
          let requests = 0;
          let requestAt;
          await context.route('**/*', async (route) => {
            const req = route.request(),
              url = req.url();
            if (req.method() !== 'GET') {
              if (url === origin + '/api/save') {
                requests++;
                requestAt = await route
                  .request()
                  .frame()
                  .page()
                  .evaluate(() => performance.now());
                return route.fulfill({
                  status: 409,
                  json: { error: 'Local measurement; no remote write' },
                });
              }
              if (url.startsWith(origin + '/api/'))
                return route.fulfill({ json: { settings: {}, revision: 'fixture' } });
              throw Error('Unexpected write: ' + url);
            }
            if (urls.has(url))
              return route.fulfill({ body: urls.get(url), contentType: 'application/json' });
            if (url === origin + '/seed')
              return route.fulfill({
                body: '<!doctype html><title>Local fixture seed</title>',
                contentType: 'text/html',
              });
            if (url.startsWith(origin)) return route.continue();
            return route.abort();
          });
          await context.addInitScript(() => {
            window.savePerf = { tasks: [], marks: {} };
            new PerformanceObserver((list) =>
              window.savePerf.tasks.push(...list.getEntries().map((e) => e.toJSON())),
            ).observe({ type: 'longtask', buffered: true });
            addEventListener('DOMContentLoaded', () =>
              new MutationObserver(() => {
                const button = [...document.querySelectorAll('button')].find(
                  (b) => b.textContent === 'Save changes',
                );
                if (
                  window.savePerf.marks.open &&
                  button &&
                  !document.body.textContent.includes('Validating save...')
                ) {
                  window.savePerf.marks.validation ??= performance.now();
                  if (!document.body.textContent.includes('Preparing save summary...'))
                    window.savePerf.marks.ready ??= performance.now();
                }
              }).observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
              }),
            );
          });
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(origin + '/seed');
          await page.evaluate(async (changes) => {
            sessionStorage.setItem(
              'clarity-editor-session',
              btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.fixture',
            );
            const drafts = Object.fromEntries(
              changes.map((c) => [c.hash, { base: c.base, next: c.next }]),
            );
            await new Promise((ok, fail) => {
              const request = indexedDB.open('clarity-editor-v2', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('drafts');
              request.onerror = () => fail(request.error);
              request.onsuccess = () => {
                const db = request.result,
                  tx = db.transaction('drafts', 'readwrite');
                tx.objectStore('drafts').put(drafts, 'tooltips:user:912345');
                tx.oncomplete = () => {
                  db.close();
                  ok();
                };
                tx.onerror = () => fail(tx.error);
              };
            });
          }, changes);
          await page.goto(origin + '/#/t/' + changes[0].hash + '?lang=en');
          await page.locator('.cm-content').first().waitFor();
          await page.locator('[data-drafts-button]').click();
          await page.locator('[data-drafts-review]:enabled').waitFor();
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          );
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          await cdp.send('Tracing.start', {
            categories: 'devtools.timeline,blink.user_timing,toplevel',
            transferMode: 'ReturnAsStream',
          });
          await page.evaluate(() => {
            window.savePerf.marks.open = performance.now();
            performance.mark('save:open');
            document.querySelector('[data-drafts-review]').click();
          });
          await page.waitForFunction(() => window.savePerf.marks.ready, {}, { timeout: 60000 });
          const save = page.getByRole('button', { name: 'Save changes', exact: true });
          if (!(await save.isEnabled()))
            throw Error('Fixture blocked: ' + (await page.getByRole('dialog').last().innerText()));
          await page.evaluate(() => {
            window.savePerf.marks.click = performance.now();
            performance.mark('save:click');
            [...document.querySelectorAll('button')]
              .find((b) => b.textContent === 'Save changes')
              .click();
          });
          await page
            .getByText('Local measurement; no remote write. Nothing was saved. Retry when ready.', {
              exact: true,
            })
            .waitFor();
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          );
          const snapshot = await page.evaluate(() => window.savePerf);
          const trace = arm + '-' + kind + '-' + rate + 'x-trace.json';
          await actor.endTrace(cdp, trace);
          const { open, ready, click, validation } = snapshot.marks;
          const panelTasks = snapshot.tasks.filter(
            (t) => t.startTime < ready && t.startTime + t.duration > open,
          );
          const saveTasks = snapshot.tasks.filter(
            (t) => t.startTime < requestAt && t.startTime + t.duration > click,
          );
          const row = {
            arm,
            kind,
            rate,
            actorSHA,
            dist: resolve(dist),
            hashes: changes.map((c) => c.hash),
            sourceCommit: fixture.sourceCommit,
            openMs: validation - open,
            summaryReadyMs: ready - open,
            saveMs: requestAt - click,
            panelTasks,
            saveTasks,
            errors,
            requests,
            trace,
            snapshot,
          };
          results.push(row);
          await writeFile(
            out + '/' + arm + '-' + kind + '-' + rate + 'x.json',
            JSON.stringify(row, null, 2),
          );
          console.log(JSON.stringify({ ...row, snapshot: undefined, hashes: row.hashes.length }));
          if (errors.length) throw Error('Page errors: ' + errors.join(';'));
          await context.close();
        }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
} finally {
  await browser.close();
}
await writeFile(out + '/summary.json', JSON.stringify(results, null, 2));
if (
  results
    .filter((r) => r.arm === 'candidate' && r.rate === 1)
    .some((r) => r.panelTasks.length || r.saveTasks.length)
)
  process.exitCode = 1;
