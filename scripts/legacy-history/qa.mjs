/* global document, window, requestAnimationFrame */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve('.agents/legacy-history/qa-dist');
const generated = resolve('.agents/legacy-history/generated');
const evidence = 'D:/GitHub/Description-editor/.agents/reports/legacy-history-impl-shots';
mkdirSync(evidence, { recursive: true });
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file =
    path === '/fixture.json' ? `${generated}/3891536761.json` : resolve(root, '.' + path);
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
try {
  for (const cpu of [1, 4])
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
          await cdp.send('Tracing.start', {
            categories: 'devtools.timeline',
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
            const elapsed = await page.evaluate(async (action) => {
              const button =
                action === 'open'
                  ? [...document.querySelectorAll('button')].find(
                      (b) => b.textContent === 'History',
                    )
                  : action === 'revision'
                    ? document.querySelector('ol li:nth-child(2) > button')
                    : [...document.querySelectorAll('button')].find(
                        (b) => b.textContent === 'vs current draft',
                      );
              const start = performance.now();
              button.click();
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              return performance.now() - start;
            }, action);
            times.push(elapsed);
            if (action === 'open') await page.locator('ol li:nth-child(2) > button').waitFor();
            else await page.getByRole('dialog').waitFor();
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
