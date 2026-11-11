// Promotes reports/review-list-evidence/review-open.mjs's paired COMPTAB opening
// protocol: production builds, fresh contexts, Review's own interactive mark,
// and 1x/4x. Adds real History replay and canonical trace attribution. No server
// ports, scratch directories, or build names belong to an individual task.
// Usage: node diff-open.mjs BASELINE_DIST CANDIDATE_DIST OUTPUT [ROUNDS=3]
// PERF_SHARED_ROOT points at the shared harness; OPEN_SCENARIO=review|history|both.
/* global window, document, location, requestAnimationFrame, MutationObserver */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [baseline, candidate, destination, roundsArg = '3'] = process.argv.slice(2);
if (!baseline || !candidate || !destination)
  throw Error('Supply both production dist paths and output');
const rounds = Number(roundsArg);
if (!Number.isInteger(rounds) || rounds < 1) throw Error('Rounds must be positive');
const roundOffset = Number(process.env.OPEN_ROUND_OFFSET || 0);
if (!Number.isInteger(roundOffset) || roundOffset < 0)
  throw Error('Round offset must be nonnegative');
const output = resolve(destination);
await mkdir(output, { recursive: true });
const builds = Object.fromEntries(
  await Promise.all(
    [
      ['baseline', baseline],
      ['candidate', candidate],
    ].map(async ([arm, dist]) => [
      arm,
      JSON.parse(await readFile(resolve(dist, 'build-source.json'), 'utf8')),
    ]),
  ),
);
if (
  !builds.baseline.commit ||
  !builds.candidate.commit ||
  !builds.baseline.vite ||
  builds.baseline.vite !== builds.candidate.vite
)
  throw Error('Build metadata must name both source commits and the same Vite version');
const shared = resolve(
  process.env.PERF_SHARED_ROOT || 'D:/GitHub/Description-editor/.agents/reports/perf-shared',
);
const moduleAt = (name) => pathToFileURL(resolve(shared, name)).href;
process.env.PERF_OUT = output;
const actorBytes = await readFile(resolve(shared, 'uniform-walk.mjs'));
await writeFile(resolve(output, 'actor.mjs'), actorBytes);
const actor = await import(moduleAt('uniform-walk.mjs'));
const { traceEvents } = await import(moduleAt('trace-events.mjs'));
const { loadHistoryReplay } = await import(moduleAt('typing/perf-history-replay.mjs'));
const replay = await loadHistoryReplay(resolve(shared, '../fixtures/history'));
const { chromium } = createRequire(resolve(process.cwd(), 'package.json'))('playwright-core');
const gen =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2/';
const urls = {
  categories: gen + 'categories.json',
  items: gen + 'items.json',
  aliases: gen + 'aliases.json',
  bundle:
    'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json',
  source: 'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json',
};
const fixtures = new Map(
  await Promise.all(
    Object.entries(urls).map(async ([name, url]) => [
      url,
      await readFile(resolve(shared, 'typing/fixtures', name + '.json'), 'utf8'),
    ]),
  ),
);
for (const body of fixtures.values()) JSON.parse(body);
const scenarios =
  (process.env.OPEN_SCENARIO || 'both') === 'both'
    ? ['review', 'history']
    : [process.env.OPEN_SCENARIO];
if (scenarios.some((value) => !['review', 'history'].includes(value)))
  throw Error('Unknown scenario');
const hash = 3891536761; // Exact recorded Kinetic Tremors history, identical in both arms.
const rows = [],
  servers = [];
const browser = await chromium.launch({
  executablePath:
    process.env.PERF_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

async function capture(arm, dist, round, rate, scenario) {
  process.argv[2] = resolve(dist);
  process.argv[3] = '0';
  const { server } = await import(
    moduleAt('typing/server.mjs') + `?capture=${arm}-${round}-${rate}-${scenario}`
  );
  servers.push(server);
  if (!server.listening)
    await new Promise((ok, fail) => {
      server.once('listening', ok);
      server.once('error', fail);
    });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [],
    blockedWrites = [],
    replayRequests = [];
  let activeAction = null;
  await context.addInitScript({
    content: `(${actor.installWriteGuard.toString()})(${JSON.stringify(actor.storageWritePolicy.toString())},${JSON.stringify(origin)});`,
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== 'GET') {
      blockedWrites.push({ url: url.href, method: request.method(), actionIndex: activeAction });
      return route.abort();
    }
    if (fixtures.has(url.href))
      return route.fulfill({ body: fixtures.get(url.href), contentType: 'application/json' });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/me')
      return route.fulfill({ json: { id: 1, login: 'perf-local', role: 'editor' } });
    if (url.pathname === '/api/settings')
      return route.fulfill({ json: { settings: null, revision: null } });
    if (url.pathname.startsWith('/api/history/')) {
      const target = url.pathname.split('/').at(-1);
      // Review opening retains the earlier COMPTAB local-opening scope: no live
      // version is supplied. Language rendering is measured in the real History
      // snapshots below; this never claims authenticated live transport latency.
      if (url.searchParams.has('live'))
        return route.fulfill({ json: { pushedHash: null, tooltip: null } });
      const key = `${target}/${url.searchParams.has('commit') ? 'commit/' + url.searchParams.get('commit') : 'page/' + (url.searchParams.get('page') || 1)}`;
      const body = replay.records.get(key);
      replayRequests.push({ key, recorded: !!body });
      if (body) {
        await new Promise((ok) => setTimeout(ok, 100));
        return route.fulfill({ body, contentType: 'application/json' });
      }
      return route.fulfill({ json: { page: 1, commits: [] } });
    }
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({ status: 403, json: { error: 'No fixture; writes disabled' } });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  const cdp = await context.newCDPSession(page);
  const cdpWrites = await actor.trackPersistence(cdp, origin, () => activeAction);
  try {
    await page.goto(origin + (scenario === 'review' ? '/#/compendium' : '/#/t/' + hash));
    await page.waitForFunction(
      () =>
        !!document.querySelector('main') &&
        !document.querySelector('[data-pane-skeleton], article[aria-busy=true]') &&
        !!document.querySelector('a[href*="/review"]'),
      null,
      { timeout: 60000 },
    );
    const initialReady = await actor.observeReady(page, null, 60000);
    if (!initialReady.ready)
      throw Error('Initial shared readiness failed: ' + JSON.stringify(initialReady));
    let target;
    if (scenario === 'history') {
      await page.getByRole('button', { name: /^History/ }).click();
      target = page.locator('[data-history-trigger]').first();
      await target.waitFor({ timeout: 30000 });
    } else target = page.getByRole('link', { name: 'Review changes', exact: true });
    // Actionability/geometry are sampled before tracing and the measured interval.
    const box = await target.boundingBox();
    if (!box) throw Error('Opening control has no visible box');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,toplevel',
      transferMode: 'ReturnAsStream',
    });
    await page.evaluate((scenario) => {
      window.canonicalActionIndex = 0;
      window.diffOpen = { start: null, done: null, scenario };
      document.addEventListener(
        'pointerdown',
        () => {
          const state = window.diffOpen;
          state.start = performance.now();
          performance.mark('diff-open:begin');
          const check = () => {
            const root =
              scenario === 'history'
                ? document.querySelector('[role=dialog][aria-label^="Revision"]')
                : document.querySelector('section[aria-label="Selected change"]');
            const interactive =
              scenario === 'history' ||
              performance
                .getEntriesByName('review:interactive')
                .some((mark) => mark.startTime >= state.start);
            const complete =
              root &&
              !root.querySelector('[aria-busy=true]') &&
              !/Loading revision|Loading last pushed/.test(root.textContent) &&
              !!root.querySelector('section[aria-label$=" comparison"]');
            if (!interactive || !complete) return;
            requestAnimationFrame(() =>
              setTimeout(() => {
                if (state.done !== null) return;
                state.done = performance.now();
                performance.mark('diff-open:ready');
                observer.disconnect();
              }, 0),
            );
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-busy'],
          });
          const marks = new PerformanceObserver(check);
          marks.observe({ type: 'mark' });
          check();
        },
        { capture: true, once: true },
      );
    }, scenario);
    activeAction = 0;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => window.diffOpen?.done !== null, null, { timeout: 30000 });
    const state = await page.evaluate(() => ({
      ...window.diffOpen,
      route: location.hash,
      interactive: performance.getEntriesByName('review:interactive').at(-1)?.startTime,
    }));
    const file = `${arm}-${round}-${rate}x-${scenario}.trace.json`;
    await actor.endTrace(cdp, file);
    // Retain deferred persistence outside the measured opening interval.
    await page.waitForTimeout(1000);
    await Promise.all(cdpWrites.pending);
    const persistence = actor.persistenceVerdict(
      await page.evaluate(
        () => window.canonicalWriteGuardStatus?.() ?? { errors: ['Write guard missing'] },
      ),
      cdpWrites,
      blockedWrites,
    );
    const events = traceEvents(resolve(output, file));
    const begin = events.find((entry) => entry.name === 'diff-open:begin');
    const offset = begin.ts - state.start * 1000;
    const inputs = events.filter(
      (entry) =>
        entry.name === 'EventTiming' &&
        entry.ph === 'b' &&
        ['pointerdown', 'click'].includes(entry.args?.data?.type) &&
        Math.abs(entry.args.data.timeStamp - state.start) < 100,
    );
    const presentation = Math.max(
      0,
      ...inputs.map((entry) => entry.args.data.timeStamp + entry.args.data.duration - state.start),
    );
    const ms = Math.max(state.done - state.start, presentation);
    const attribution = actor.attribute(
      events,
      begin.ts,
      offset + (state.start + ms) * 1000,
      begin.pid,
      begin.tid,
    );
    const longTasks = events
      .filter(
        (entry) =>
          /RunTask$/.test(entry.name) &&
          entry.pid === begin.pid &&
          entry.tid === begin.tid &&
          entry.ts + entry.dur > begin.ts &&
          entry.ts < offset + (state.start + ms) * 1000 &&
          entry.dur > 50000,
      )
      .map((entry) => entry.dur / 1000);
    const result = {
      arm,
      round,
      rate,
      scenario,
      hash: scenario === 'history' ? hash : null,
      ms,
      proxyMs: state.done - state.start,
      eventPresentationMs: presentation,
      interactiveMs: scenario === 'review' ? state.interactive - state.start : null,
      attribution,
      initialReady,
      longTasks,
      replayRequests,
      errors,
      blockedWrites,
      persistence,
      trace: file,
      route: state.route,
    };
    result.valid = !(
      errors.length ||
      !persistence.valid ||
      blockedWrites.length ||
      !Number.isFinite(ms) ||
      (scenario === 'history' && !replayRequests.some((request) => request.recorded))
    );
    rows.push(result);
    console.log(
      JSON.stringify({
        arm,
        round,
        rate,
        scenario,
        ms,
        appMain: attribution.appMainWallMs,
        valid: result.valid,
      }),
    );
    if (!result.valid) throw Error('Invalid capture: ' + JSON.stringify(result));
  } finally {
    await context.close();
    await new Promise((ok) => server.close(ok));
  }
}
try {
  for (let round = roundOffset; round < roundOffset + rounds; round++) {
    const arms =
      round % 2
        ? [
            ['candidate', candidate],
            ['baseline', baseline],
          ]
        : [
            ['baseline', baseline],
            ['candidate', candidate],
          ];
    for (const rate of [1, 4])
      for (const scenario of scenarios)
        for (const [arm, dist] of arms) await capture(arm, dist, round, rate, scenario);
  }
} finally {
  await browser.close();
  await Promise.all(
    servers
      .filter((server) => server.listening)
      .map((server) => new Promise((ok) => server.close(ok))),
  );
  const summary = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      Object.fromEntries(
        [1, 4].map((rate) => [
          rate,
          Object.fromEntries(
            ['baseline', 'candidate'].map((arm) => [
              arm,
              actor.summary(
                rows
                  .filter(
                    (row) => row.scenario === scenario && row.rate === rate && row.arm === arm,
                  )
                  .map((row) => row.ms),
              ),
            ]),
          ),
        ]),
      ),
    ]),
  );
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        valid: rows.length === rounds * 2 * 2 * scenarios.length && rows.every((row) => row.valid),
        builds,
        protocol:
          'Promoted COMPTAB Review open; native pointer input; later of EventTiming presentation and post-frame complete diff; 100ms exact History replay; Review live=null fixture, not transport proof',
        actorSHA256: createHash('sha256').update(actorBytes).digest('hex'),
        history: replay.metadata,
        rows,
        summary,
      },
      null,
      2,
    ),
  );
}
if (rows.length !== rounds * 2 * 2 * scenarios.length) throw Error('Incomplete paired capture');
