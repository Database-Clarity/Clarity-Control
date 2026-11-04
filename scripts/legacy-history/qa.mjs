/* global document, window, requestAnimationFrame */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const root = resolve('.agents/legacy-history/qa-dist');
const generated = resolve('.agents/legacy-history/generated');
const fixtureHash = process.env.LEGACY_QA_HASH ?? '3891536761';
const revisionRow = Number(process.env.LEGACY_QA_ROW ?? 2);
const cpus = process.env.LEGACY_QA_CPU ? [Number(process.env.LEGACY_QA_CPU)] : [1, 4];
if (
  !/^\d+$/.test(fixtureHash) ||
  ![2, 3, 4].includes(revisionRow) ||
  cpus.some((cpu) => ![1, 4].includes(cpu))
)
  throw new Error('Invalid QA cohort');
const evidenceRoot = 'D:/GitHub/Description-editor/.agents/reports/legacy-history-impl-shots';
const evidence = process.env.LEGACY_QA_RUN
  ? `${evidenceRoot}/${fixtureHash}-${process.env.LEGACY_QA_RUN}`
  : evidenceRoot;
mkdirSync(evidence, { recursive: true });
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file =
    path === '/fixture.json' ? `${generated}/${fixtureHash}.json` : resolve(root, '.' + path);
  if (!file.startsWith(root) && !file.startsWith(generated)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(5246, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const results = [];
const fixture = JSON.parse(readFileSync(`${generated}/${fixtureHash}.json`, 'utf8'));
const revisions = fixture.lanes.find((lane) => lane.verified).revisions;
const selected = revisions.at(-revisionRow).text ?? {};
const next = revisions.at(1 - revisionRow).text ?? {};
const current = [...revisions].reverse().find((revision) => revision.text !== null).text;
try {
  for (const cpu of cpus)
    for (const theme of ['dark', 'light'])
      for (const width of [390, 768, 1280])
        for (const scale of [100, 150]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          await page.route('**/raw.githubusercontent.com/**', async (route) => {
            const hash = new URL(route.request().url()).pathname.split('/').at(-1);
            const file = `${generated}/${hash}`;
            await route.fulfill(
              existsSync(file)
                ? { status: 200, contentType: 'application/json', body: readFileSync(file) }
                : { status: 404, body: '' },
            );
          });
          await page.route('**/history/*', (route) =>
            route.fulfill({ json: { page: 1, commits: [] } }),
          );
          await page.goto('http://127.0.0.1:5246/test/legacy-history.html');
          const toggle = page.getByRole('button', { name: 'History', exact: true });
          await toggle.waitFor();
          await page.evaluate(
            ({ theme, scale }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
            },
            { theme, scale },
          );
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
          // Settle harness theme/scale changes before measuring app actions. This does
          // not open history, fetch its artifact, or warm any revision/diff cache.
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          });
          await cdp.send('Tracing.start', {
            categories: 'devtools.timeline,toplevel,blink.user_timing',
            transferMode: 'ReturnAsStream',
          });
          await page.evaluate(() => {
            window.__tasks = [];
            new PerformanceObserver((list) =>
              window.__tasks.push(...list.getEntries().map((entry) => entry.duration)),
            ).observe({ type: 'longtask' });
          });
          const times = [];
          for (const action of ['open', 'revision', 'compare']) {
            await page.evaluate(
              ({ action, revisionRow }) => {
                window.__action = undefined;
                const button =
                  action === 'open'
                    ? [...document.querySelectorAll('button')].find(
                        (b) => b.textContent === 'History',
                      )
                    : action === 'revision'
                      ? document.querySelector(`ol li:nth-child(${revisionRow}) > button`)
                      : [...document.querySelectorAll('button')].find(
                          (b) => b.textContent === 'vs current draft',
                        );
                if (!button || button.disabled) throw new Error(`Action ${action} is not ready`);
                const down = (event) => {
                  if (!button.contains(event.target)) return;
                  if (!event.isTrusted) throw new Error('QA requires trusted input');
                  const start = performance.now();
                  performance.mark(`legacy-${action}-start`);
                  document.removeEventListener('pointerdown', down, true);
                  // Focusing a revision can open its fixed popover before mouseup;
                  // on narrow screens the click may then land on the shared li.
                  // Measure the delivered pointer intent that actually opens it.
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                      performance.mark(`legacy-${action}-double-raf`);
                      window.__action = performance.now() - start;
                    }),
                  );
                };
                document.addEventListener('pointerdown', down, true);
              },
              { action, revisionRow },
            );
            const control =
              action === 'open'
                ? toggle
                : action === 'revision'
                  ? page.locator(`ol li:nth-child(${revisionRow}) > button`)
                  : page.getByRole('button', { name: 'vs current draft', exact: true });
            // Playwright's readiness/layout probes finish before the trusted
            // pointerdown mark, so they cannot inflate the measured interval.
            await control.click();
            await page.waitForFunction(() => typeof window.__action === 'number');
            times.push(await page.evaluate(() => window.__action));
            if (action === 'open')
              await page.locator(`ol li:nth-child(${revisionRow}) > button`).waitFor();
            else {
              await page.getByRole('dialog').waitFor();
              await page.waitForFunction(() => {
                const button = [...document.querySelectorAll('button')].find(
                  (b) => b.textContent === 'vs current draft',
                );
                return (
                  button &&
                  !button.disabled &&
                  !document.querySelector('[role="dialog"] [aria-busy="true"]')
                );
              });
              const actual = await page.evaluate(() =>
                Object.fromEntries(
                  [...document.querySelectorAll('[role="dialog"] section[lang]')].map((section) => {
                    const diff = section.querySelector('[aria-label^="Word diff:"]');
                    const text = (excluded) =>
                      [...diff.childNodes]
                        .filter((node) => node.nodeName !== excluded)
                        .map((node) => node.textContent)
                        .join('');
                    return [
                      section.getAttribute('lang'),
                      { before: text('INS'), after: text('DEL') },
                    ];
                  }),
                ),
              );
              const target = action === 'revision' ? next : current;
              const expected = Object.fromEntries(
                [...new Set([...Object.keys(selected), ...Object.keys(target)])]
                  .filter((lang) => selected[lang] !== target[lang])
                  .map((lang) => [
                    lang,
                    { before: selected[lang] ?? '', after: target[lang] ?? '' },
                  ]),
              );
              for (const [lang, value] of Object.entries(expected)) {
                if (!value.before && !value.after && actual[lang]?.before === 'No text')
                  actual[lang] = value;
              }
              assert.deepEqual(
                actual,
                expected,
                'Every deferred language preserves both complete texts',
              );
            }
          }
          const geometry = await page.evaluate(() => {
            const d = document.querySelector('[role="dialog"]');
            const rect = d.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              inner: d.scrollWidth - d.clientWidth,
              left: rect.left,
              right: rect.right,
              clipped: [...d.querySelectorAll('button')]
                .filter((b) => b.scrollWidth > b.clientWidth + 1)
                .map((b) => b.textContent),
            };
          });
          const tasks = await page.evaluate(() => window.__tasks);
          await page.screenshot({ path: `${evidence}/${cpu}x-${theme}-${width}-${scale}.png` });
          const tracing = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
          await cdp.send('Tracing.end');
          const { stream } = await tracing;
          let trace = '';
          while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream });
            trace += chunk.data;
            if (chunk.eof) break;
          }
          await cdp.send('IO.close', { handle: stream });
          writeFileSync(`${evidence}/${cpu}x-${theme}-${width}-${scale}.trace.json`, trace);
          results.push({ cpu, theme, width, scale, times, tasks, geometry });
          await page.close();
        }
  writeFileSync(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  server.close();
}
