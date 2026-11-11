/* global document, window, getComputedStyle, requestAnimationFrame, location */
// Export site E2E and render QA (EXPORT-P4): the real app (Vite) against the local Worker (P3's
// in-memory GitHub, exports-worker-child.mjs) and a local fixture data site (snapshot built from
// the repo's fixtures with the engine bundle exactly as build.mjs makes it). Nothing leaves the
// machine except the app's own public data loads (generator catalog and bundle).
//
//   node apps/web/test/exports-browser.mjs <out dir> [--perf] [--built] [--skip-preview]
//
// `--built` runs a production build (vite build, then vite preview) instead of the dev server, so
// the bundle and its chunking are what is tested and measured.
//
// Default: G-PREVIEW in the browser, roles (maintainer and partner, UI and Worker refusals), URL
// and Back state, keyboard through the symbol table, the state sweep (save, 409 reload keeping
// edits, 429 countdown, failed build status, empty project, 3-file cap, a removed file inside its
// retained window), and screenshots at 390/768/1280, dark and light, UI 100 and 150, with
// overflow and clipping checks. `--perf` only measures the sample repaint after option changes
// (AC3) and prints JSON; run it through the measurement queue.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { build as viteBuild, createServer, preview } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(web, '../..');
const out = resolve(process.argv[2] ?? join(root, '.agents/export-p4'));
const perfOnly = process.argv.includes('--perf');
const work = join(out, 'work');
const shots = join(out, 'shots');
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const ports = { app: 5361, worker: 5362, site: 5363 };
const appOrigin = `http://127.0.0.1:${ports.app}`;
const workerUrl = `http://127.0.0.1:${ports.worker}`;
const siteUrl = `http://127.0.0.1:${ports.site}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const log = (...parts) => console.log(...parts);

// 1. The engine and the fixture snapshot -------------------------------------------------------
const engineText = (
  await build({
    entryPoints: [join(root, 'packages/export/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    legalComments: 'inline',
    logLevel: 'warning',
  })
).outputFiles[0].text;
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(engineText).toString('base64')}`
);
const inputBytes = readFileSync(join(root, 'packages/core/test/fixtures/live.json'));
const input = JSON.parse(inputBytes.toString('utf8'));
const catalog = JSON.parse(
  gunzipSync(readFileSync(join(root, 'packages/export/test/fixtures/catalog-c3fed8c.json.gz'))),
);
const identical = JSON.parse(
  readFileSync(join(root, 'packages/export/test/fixtures/legacy-identical.json'), 'utf8'),
).live;
const compile = (file) => engine.compile(input, file, { catalog, identical }).bytes;

const siteDir = join(work, 'site');
const put = (path, bytes) => {
  const target = join(siteDir, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
};
const snapshot = {
  'engine.mjs': Buffer.from(engineText),
  'input.json': inputBytes,
  'identical.json': Buffer.from(JSON.stringify(identical)),
  'catalog.json': Buffer.from(JSON.stringify(catalog)),
};
const buildId = sha(Object.values(snapshot).map(sha).join('\n')).slice(0, 16);
for (const [name, bytes] of Object.entries(snapshot)) put(`_build/${buildId}/${name}`, bytes);
const liveCommit = 'c0ffee'.padEnd(40, '0');
const legacy = {};
for (const preset of engine.deployedLegacyPresets) {
  const bytes = compile({ id: 'x1', formatVersion: 1, preset });
  legacy[`${preset}.json`] = { sha256: sha(bytes), outcome: 'built' };
  put(`live/${liveCommit}/descriptions/${preset}.json`, bytes);
}

// Projects the E2E creates in the local Worker; the fixture site has deployed some of them.
const chosen = ['weapon-trait', 'weapon-frame', 'armor-set-bonus', 'armor-trait-exotic'];
const markdown = (sandbox) => ({
  ...engine.newStyleFile('descriptions', 'markdown', {
    ...engine.defaultData(),
    categories: chosen,
    sandboxPerks: sandbox ? ['weapon-trait'] : [],
    keys: ['name', 'itemHash'],
  }),
});
const deployedSample = markdown(false);
deployedSample.format.symbols.bold = { mode: 'replace', before: '__', after: '__' };
const projects = [
  {
    schema: 1,
    id: 'dim',
    name: 'Destiny Item Manager',
    files: [{ id: 'descriptions', formatVersion: 1, preset: 'dim' }],
  },
  {
    schema: 1,
    id: 'sample',
    name: 'Sample partner app',
    files: [
      markdown(true),
      { ...engine.newStyleFile('lines', 'structured'), data: markdown(true).data },
    ],
  },
  {
    schema: 1,
    id: 'full',
    name: 'Three files',
    files: ['a1', 'b1', 'c1'].map((id) => engine.newStyleFile(id, 'plain')),
  },
  { schema: 1, id: 'empty', name: 'No files yet', files: [] },
];
const now = new Date().toISOString();
const manifestFiles = {};
const deploy = (path, bytes, outcome = 'built') => {
  put(path, bytes);
  manifestFiles[path] = {
    sha256: sha(bytes),
    bytes: bytes.byteLength,
    lastUpdate: now,
    lastBuilt: now,
    outcome,
  };
};
deploy(
  'dim/v1/descriptions.json',
  compile({ id: 'descriptions', formatVersion: 1, preset: 'dim' }),
);
deploy('sample/v1/descriptions.json', compile(deployedSample));
deploy('full/v1/a1.json', compile(projects[2].files[0]));
deploy('full/v1/b1.json', compile(projects[2].files[1]), 'carried');
deploy('full/v1/c1.json', compile(projects[2].files[2]), 'frozen');
const notices = [
  {
    project: 'sample',
    file: 'lines',
    path: 'sample/v1/lines.json',
    kind: 'not-published',
    message: 'Build failed: fixture failure; not published yet (404)',
  },
  {
    project: 'full',
    file: 'b1',
    path: 'full/v1/b1.json',
    kind: 'carried-forward',
    message: 'Carried forward',
  },
];
const status = {
  buildId,
  builtAt: now,
  files: Object.fromEntries(Object.entries(snapshot).map(([name, bytes]) => [name, sha(bytes)])),
  engine: 'fixture',
  converterSha: '0bd5daebe80c1efcbad21d86658ec5d70e4f0da5',
  generatorSha: 'c3fed8cbdebc1a810d2ce1527d12c3f3530535e2',
  manifestVersion: 'fixture',
  pinId: 'fixture-pin',
  liveCommit,
  legacy,
};
put('_build/status.json', Buffer.from(JSON.stringify(status)));
put(
  '_build/manifest.json',
  Buffer.from(JSON.stringify({ manifestVersion: 1, buildId, builtAt: now, files: manifestFiles })),
);
put('_build/notices.json', Buffer.from(JSON.stringify(notices)));

const types = { '.json': 'application/json', '.mjs': 'text/javascript' };
const site = createHttpServer((req, res) => {
  const path = join(siteDir, ...decodeURIComponent(new URL(req.url, siteUrl).pathname).split('/'));
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (!path.startsWith(siteDir) || !existsSync(path)) return res.writeHead(404, headers).end();
  res.writeHead(200, {
    ...headers,
    'Content-Type': types[extname(path)] ?? 'application/octet-stream',
  });
  createReadStream(path).pipe(res);
});
await new Promise((ready) => site.listen(ports.site, '127.0.0.1', ready));

// 2. The local Worker --------------------------------------------------------------------------
const workerBundle = join(work, 'exports-local.mjs');
await build({
  entryPoints: [join(root, 'apps/worker/test/exportsLocal.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  outfile: workerBundle,
  logLevel: 'warning',
});
const child = spawn(
  process.execPath,
  [
    join(web, 'test/exports-worker-child.mjs'),
    workerBundle,
    String(ports.worker),
    appOrigin,
    JSON.stringify(catalog.categories.map(({ id }) => ({ id, name: id }))),
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((ready, fail) => {
  child.stdout.once('data', ready);
  child.once('exit', (code) => fail(new Error(`worker child exited ${code}`)));
});
const call = async (method, path, body, token) => {
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: {
      Origin: appOrigin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
await call(
  'POST',
  '/__configure',
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
);
const token = async (id) => (await call('GET', `/__token?id=${id}`)).body.token;
const MAINTAINER = await token(1);
const ACME = 5004; // exportsLocal resolves a new login to 5000 + its length
const PARTNER = await token(ACME);
// The in-memory GitHub starts with 40 projects (the maximum): make room for these four.
for (const n of [36, 37, 38, 39]) await call('POST', `/__drop?id=project-${n}`);
for (const project of projects) {
  const created = await call('POST', '/exports/projects', { config: project }, MAINTAINER);
  assert.equal(created.status, 201, `create ${project.id}: ${JSON.stringify(created.body)}`);
}
const list = await call('GET', '/exports/projects', undefined, MAINTAINER);
const partnered = await call(
  'PUT',
  '/exports/projects/sample/partners',
  { revision: list.body.partnersRevision, logins: ['acme'] },
  MAINTAINER,
);
assert.equal(partnered.status, 200, JSON.stringify(partnered.body));

// 3. The app -----------------------------------------------------------------------------------
process.env.VITE_API_URL = workerUrl;
process.env.VITE_DATA_SITE_URL = siteUrl;
process.env.VITE_LIVE_RAW_URL = `${siteUrl}/live`;
const built = process.argv.includes('--built');
const appServer = { host: '127.0.0.1', port: ports.app, strictPort: true };
let server;
if (built) {
  const outDir = join(work, 'dist');
  await viteBuild({
    root: web,
    configLoader: 'runner',
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      // The G-PREVIEW page joins the build so its workers are the production ones too.
      rollupOptions: {
        input: { main: join(web, 'index.html'), preview: join(web, 'test/exports-preview.html') },
      },
    },
  });
  server = await preview({
    root: web,
    configLoader: 'runner',
    logLevel: 'warn',
    build: { outDir },
    preview: appServer,
  });
} else {
  server = await createServer({
    root: web,
    configLoader: 'runner',
    logLevel: 'warn',
    server: appServer,
  });
  await server.listen();
}
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

async function open({ who, width = 1280, height = 900, theme = 'dark', scale = 100, path = '/' }) {
  const phone = width <= 700;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    ({ session, scale }) => {
      if (session) localStorage.setItem('clarity-editor-session', session);
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: scale }));
    },
    { session: who ?? null, scale },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource|favicon/.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(`${appOrigin}/#${path}`);
  return { page, context, errors };
}
const ready = (page, selector, timeout = 60_000) =>
  page.waitForSelector(selector, { timeout, state: 'visible' });
const sampleShown = (page) =>
  page.waitForFunction(
    () => {
      const entry = document.querySelector('[data-config-version]');
      return (
        entry &&
        entry.getAttribute('data-rendered-version') === entry.getAttribute('data-config-version')
      );
    },
    undefined,
    { timeout: 60_000 },
  );
// A sample hash: a weapon trait in the published input, with an import-free text.
const sampleHash = Object.keys(input.perks).find(
  (hash) =>
    catalog.items[hash]?.categoryId === 'weapon-trait' &&
    !('aliasOf' in input.perks[hash]) &&
    /bold|<b|\*\*/i.test(JSON.stringify(input.perks[hash].editor.en ?? '')) === false,
);

const results = { buildId, sampleHash };

if (perfOnly) {
  // AC3: sample repaint after an option change, and long tasks on the main thread (1x).
  const { page, context } = await open({
    who: MAINTAINER,
    path: `/exports/sample?pick=${sampleHash}`,
  });
  await ready(page, '[aria-label="Bold mode"]');
  await sampleShown(page);
  await page.evaluate(() => {
    // Input-to-paint: from the pointer event's own timestamp, so Playwright's actionability
    // waits before it dispatches (two stable frames) are not counted as app time.
    document.addEventListener('pointerdown', (event) => (window.__inputAt = event.timeStamp), true);
    window.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
  });
  const repaint = [];
  const rows = ['Bold', 'Arc', 'Solar', 'Void', 'Titles', 'Links', 'Spacer lines', 'PvE'];
  for (let round = 0; round < 3; round++)
    for (const row of rows) {
      const group = page.locator(`[aria-label="${row} mode"]`);
      const buttons = group.locator('button:not([disabled]):not([aria-pressed="true"])');
      const ms = await page.evaluate(() => {
        window.__inputAt = null;
        const entry = document.querySelector('[data-config-version]');
        return Number(entry.getAttribute('data-config-version'));
      });
      await buttons.first().click();
      const elapsed = await page.evaluate(
        (before) =>
          new Promise((done) => {
            const check = () => {
              if (window.__inputAt === null) return requestAnimationFrame(check);
              const entry = document.querySelector('[data-config-version]');
              const asked = Number(entry.getAttribute('data-config-version'));
              const shown = Number(entry.getAttribute('data-rendered-version'));
              if (asked > before && shown === asked)
                requestAnimationFrame(() => done(performance.now() - window.__inputAt));
              else requestAnimationFrame(check);
            };
            check();
          }),
        ms,
      );
      repaint.push(Math.round(elapsed * 10) / 10);
    }
  const longTasks = await page.evaluate(() => window.longTasks);
  await context.close();
  const sorted = [...repaint].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      repaintMs: repaint,
      median: sorted[Math.floor(sorted.length / 2)],
      p90: sorted[Math.floor(sorted.length * 0.9)],
      max: sorted.at(-1),
      longTasks,
    }),
  );
  await finish();
  process.exit(0);
}

// 4. G-PREVIEW in the browser --------------------------------------------------------------------
if (!process.argv.includes('--skip-preview')) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loaded = await page.goto(`${appOrigin}/test/exports-preview.html`);
  assert.equal(loaded?.status(), 200, 'G-PREVIEW page');
  await page.waitForFunction(() => window.previewCheck, undefined, { timeout: 600_000 });
  const check = await page.evaluate(() => window.previewCheck);
  assert.ok(!check.error, check.error);
  let equal = 0;
  for (const { file, sha256 } of check.results) {
    assert.equal(sha256, sha(compile(file)), `G-PREVIEW ${file.id}`);
    equal += 1;
  }
  results.gPreview = { files: equal, ms: check.results.map((result) => Math.round(result.ms)) };
  log(`G-PREVIEW: ${equal} worker builds equal the Node builds byte for byte`);
  await context.close();
}

// 5. Roles: the Worker refuses a partner outside its own project and outside `files` ----------
{
  const own = await call('GET', '/exports/projects?project=sample', undefined, PARTNER);
  assert.equal(own.status, 200);
  const refusals = {
    otherProject: (await call('GET', '/exports/projects?project=dim', undefined, PARTNER)).status,
    saveOther: (
      await call(
        'PUT',
        '/exports/projects/dim',
        { revision: own.body.revision, config: own.body.config },
        PARTNER,
      )
    ).status,
    rename: (
      await call(
        'PUT',
        '/exports/projects/sample',
        { revision: own.body.revision, config: { ...own.body.config, name: 'Taken over' } },
        PARTNER,
      )
    ).status,
    create: (
      await call('POST', '/exports/projects', { config: { ...projects[3], id: 'mine' } }, PARTNER)
    ).status,
    remove: (
      await call('DELETE', '/exports/projects/sample', { revision: own.body.revision }, PARTNER)
    ).status,
    partners: (
      await call(
        'PUT',
        '/exports/projects/sample/partners',
        { revision: 'a'.repeat(40), logins: ['acme', 'x'] },
        PARTNER,
      )
    ).status,
    tooltipsSave: (await call('POST', '/save', { changes: [], message: 'x' }, PARTNER)).status,
  };
  for (const [name, code] of Object.entries(refusals))
    assert.ok(code === 403 || code === 400, `partner ${name}: ${code}`);
  const listed = await call('GET', '/exports/projects', undefined, PARTNER);
  assert.deepEqual(
    listed.body.projects.map((project) => project.id),
    ['sample'],
  );
  assert.equal(listed.body.partnersRevision, undefined);
  results.workerRefusals = refusals;
  log('Worker refusals for the partner:', JSON.stringify(refusals));
}

// 6. Partner UI ------------------------------------------------------------------------------------
{
  const { page, context, errors } = await open({ who: PARTNER });
  try {
    await page.waitForURL(/#\/exports\/sample/, { timeout: 60_000 });
  } catch (error) {
    const me = await page.evaluate(async (url) => {
      const token = localStorage.getItem('clarity-editor-session');
      const response = await fetch(`${url}/me`, { headers: { Authorization: `Bearer ${token}` } });
      return `${response.status} ${await response.text()} token=${token?.slice(0, 20)}`;
    }, workerUrl);
    await page.screenshot({ path: join(shots, 'debug-partner.png') });
    console.log('partner /me:', me, 'errors:', errors);
    throw error;
  }
  await ready(page, '[aria-label="Bold mode"]');
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll('header a, header button')].map((el) => el.textContent.trim()),
  );
  assert.ok(nav.includes('Exports') && nav.includes('Tooltips'), `partner nav: ${nav}`);
  assert.ok(
    !nav.includes('Editor') && !nav.includes('Compendium') && !nav.includes('Review changes'),
    `partner nav: ${nav}`,
  );
  assert.equal(await page.locator('text=Delete…').count(), 0);
  assert.equal(
    await page.locator('[class*="crumb"]').count(),
    0,
    'partner sees no projects-list crumb',
  );
  // Files-only edits: the partner changes a symbol and saves.
  await page.locator('[aria-label="Arc mode"] button:has-text("Drop")').click();
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Saved. The data site rebuilds');
  await page.goto(`${appOrigin}/#/exports/dim`);
  await ready(page, 'text=This account cannot open this export project.');
  await page.goto(`${appOrigin}/#/tooltips?hash=${sampleHash}`);
  await ready(page, `section[aria-label$=" preview"]`);
  await page.screenshot({ path: join(shots, 'partner-tooltips-1280-dark.png') });
  assert.deepEqual(errors, [], `partner page errors: ${errors}`);
  await context.close();
  log('Partner UI: lands on its project, Exports + Tooltips only, saves files, refused elsewhere');
}

// 7. Maintainer flows: list, URL/Back, keyboard, diff, numbers, state sweep ----------------------
{
  const { page, context, errors } = await open({ who: MAINTAINER, path: '/exports' });
  await ready(page, 'table >> text=sample');
  await page
    .waitForFunction(() => !document.querySelector('[data-state="unknown"]'))
    .catch(async (error) => {
      await page.screenshot({ path: join(shots, 'debug-list.png') });
      console.log(
        'list header:',
        await page
          .locator('section')
          .first()
          .innerText()
          .catch(() => ''),
        errors,
      );
      throw error;
    });
  const rows = await page.locator('tbody tr').count();
  assert.equal(rows, 40, `list rows ${rows}`);
  const dots = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('tbody tr')].map((row) => [
        row.querySelector('th a')?.textContent,
        row.querySelector('[data-state]')?.getAttribute('data-state'),
      ]),
    ),
  );
  assert.equal(dots.dim, 'live');
  assert.equal(dots.sample, 'bad');
  assert.equal(dots.full, 'bad');
  assert.equal(dots.empty, 'none');
  await page.screenshot({ path: join(shots, 'list-1280-dark.png'), fullPage: false });

  // URL and Back: project -> file tab -> picks.
  await page.locator('a:has-text("sample")').first().click();
  await ready(page, '[aria-label="Bold mode"]');
  await page.locator('[role="tab"]:has-text("lines")').click();
  await page.waitForURL(/file=lines/);
  await page.goto(`${appOrigin}/#/exports/sample?file=lines&pick=${sampleHash}`);
  await sampleShown(page);
  const search = page.locator('input[role="combobox"]');
  await search.fill(input.perks[sampleHash].name.slice(0, 6));
  await ready(page, '[role="option"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Recent picks"] button').length > 0,
  );
  const picked = new URL(page.url().replace('#', '')).searchParams.get('pick');
  await page.goBack();
  await page.waitForFunction((hash) => location.hash.includes(`pick=${hash}`), sampleHash);
  await page.goBack();
  await page.waitForFunction(
    () => location.hash.includes('file=lines') && !location.hash.includes('pick='),
  );
  await page.goBack();
  await page.waitForFunction(
    () => location.hash.includes('/exports/sample') && !location.hash.includes('file='),
  );
  results.urlBack = { picked };
  log('URL and Back: file tab and picks are history entries');

  // Keyboard through the symbol table.
  await page.goto(`${appOrigin}/#/exports/sample?pick=${sampleHash}`);
  await ready(page, '[aria-label="Arc mode"]');
  await page.locator('[aria-label="Kinetic mode"] button[tabindex="0"]').focus();
  const focusPath = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    focusPath.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        return `${el.closest('[role="group"]')?.getAttribute('aria-label') ?? el.tagName}:${el.textContent.trim()}`;
      }),
    );
  }
  // Tab walks row by row (one stop per control); arrows move inside a control; Space chooses.
  const groups = focusPath.map((step) => step.split(':')[0]);
  assert.ok(
    groups.every((group) => / mode$|^INPUT$|^BUTTON$/.test(group)) &&
      groups.every((group, index) => !group.endsWith('mode') || group !== groups[index - 1]),
    focusPath.join(' > '),
  );
  // Back to a segmented control for the arrow check.
  await page.locator('[aria-label="Strand mode"] button[tabindex="0"]').focus();
  await page.keyboard.press('ArrowRight');
  const moved = await page.evaluate(() => document.activeElement.textContent.trim());
  await page.keyboard.press('Space');
  const pressed = await page.evaluate(() => document.activeElement.getAttribute('aria-pressed'));
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(pressed, 'true');
  assert.notEqual(outline, 'none');
  results.keyboard = { focusPath, moved, outline };
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');

  // Preview: live label, diff, numbers.
  await sampleShown(page);
  const label = await page.locator('[data-kind]').first().textContent();
  assert.equal(label, 'Preview build');
  await page.locator('button:has-text("Diff vs live file")').click();
  await sampleShown(page);
  await page.waitForSelector('[aria-label^="Word diff"]');
  await page.locator('button:has-text("Build whole file")').click();
  await ready(page, 'text=changed vs live', 120_000);
  await page.screenshot({ path: join(shots, 'project-diff-numbers-1280-dark.png') });
  results.numbers = await page.locator('[class*="numberList"]').textContent();

  // Save, then 429 countdown, then 409 reload keeping edits.
  await page.locator('[aria-label="Solar mode"] button:has-text("Drop")').click();
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Saved. The data site rebuilds');
  await call('GET', '/__cooldown?on=1');
  await page.locator('[aria-label="Void mode"] button:has-text("Drop")').click();
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Saved moments ago');
  const countdown = await page.locator('button:has-text("Save in")').textContent();
  assert.match(countdown, /Save in \d+ s/);
  await call('GET', '/__cooldown?on=0');
  const stored = await call('GET', '/exports/projects?project=sample', undefined, MAINTAINER);
  const renamed = await call(
    'PUT',
    '/exports/projects/sample',
    {
      revision: stored.body.revision,
      config: { ...stored.body.config, name: 'Renamed elsewhere' },
    },
    MAINTAINER,
  );
  assert.equal(renamed.status, 200);
  await page.waitForSelector('button:has-text("Save"):not([disabled])', { timeout: 40_000 });
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Someone saved this project');
  assert.equal(await page.locator('h1:has-text("Renamed elsewhere")').count(), 1);
  assert.equal(
    await page
      .locator('[aria-label="Void mode"] button:has-text("Drop")')
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.screenshot({ path: join(shots, 'state-409-1280-dark.png') });
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Saved. The data site rebuilds');

  // A removed file inside its retained window.
  await page.locator('[role="tab"]:has-text("lines")').click();
  await page.locator('button:has-text("Remove file")').click();
  await ready(page, 'text=kept for 3 months after you save');
  await page.locator('button:has-text("Save")').click();
  await ready(page, 'text=Saved. The data site rebuilds');
  await ready(page, 'text=sample/v1/lines.json');
  await page.screenshot({ path: join(shots, 'state-retained-1280-dark.png') });

  // Failed build status, empty project, 3-file cap.
  await page.goto(`${appOrigin}/#/exports/full`);
  await ready(page, '[role="tab"]:has-text("c1")');
  assert.equal(await page.locator('button:has-text("+ File")').isDisabled(), true);
  await page.locator('[role="tab"]:has-text("b1")').click();
  await ready(page, 'text=Carried');
  await page.screenshot({ path: join(shots, 'state-cap-carried-1280-dark.png') });
  await page.goto(`${appOrigin}/#/exports/empty`);
  await ready(page, 'text=This project has no files yet');
  await page.screenshot({ path: join(shots, 'state-empty-1280-dark.png') });
  await page.goto(`${appOrigin}/#/exports/dim?pick=${sampleHash}`);
  await sampleShown(page);
  assert.equal(await page.locator('[data-kind]').first().textContent(), 'Live file');
  assert.equal(await page.locator('button:has-text("Diff vs live file")').isDisabled(), true);
  await page.screenshot({ path: join(shots, 'state-live-legacy-1280-dark.png') });
  assert.deepEqual(errors, [], `maintainer page errors: ${errors}`);
  await context.close();
  log('Maintainer flows and state sweep passed');
}

// 8. Render QA ----------------------------------------------------------------------------------
const overflow = (page) =>
  page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest('[hidden]')) return false;
        // Content inside a horizontal scroller (the projects table) may extend past the window.
        for (let p = el.parentElement; p; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (
            /(auto|scroll|hidden)/.test(style.overflowX) &&
            p !== document.body &&
            p !== document.documentElement
          )
            return false;
        }
        return r.right > window.innerWidth + 1;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
    clipped: [...document.querySelectorAll('button, select, input, [role="tab"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[hidden]')) return false;
        if (el.tagName === 'INPUT') return false;
        const style = getComputedStyle(el);
        if (style.textOverflow === 'ellipsis') return false;
        // Wrapped or cut text: wider or taller than the control's box.
        return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
    // Stacked page parts never overlap (the project header above the view tabs or columns).
    overlap: [...document.querySelectorAll('[class*="projectHeader"], [class*="banner"]')]
      .filter((el) => {
        const next = el.nextElementSibling;
        return next && el.getBoundingClientRect().bottom > next.getBoundingClientRect().top + 1;
      })
      .map((el) => String(el.className).slice(0, 40)),
    tall: [
      ...document.querySelectorAll(
        '[class*="segmented"] button, [class*="fileTab"], [class*="primary"]',
      ),
    ]
      .filter((el) => el.getBoundingClientRect().height > 60)
      .map((el) => el.textContent.trim()),
  }));
const matrix = [];
for (const width of [390, 768, 1280])
  for (const theme of ['dark', 'light'])
    for (const scale of [100, 150]) {
      const views = [
        { name: 'list', who: MAINTAINER, path: '/exports', wait: 'table >> text=sample' },
        {
          name: 'project',
          who: MAINTAINER,
          path: `/exports/sample?pick=${sampleHash}`,
          wait: '[aria-label="Bold mode"]',
        },
        {
          name: 'tooltips',
          who: PARTNER,
          path: `/tooltips?hash=${sampleHash}`,
          wait: 'section[aria-label$=" preview"]',
        },
      ];
      if (width < 900)
        views.push({
          name: 'project-preview',
          who: MAINTAINER,
          path: `/exports/sample?pick=${sampleHash}&view=preview`,
          wait: '[data-config-version]',
        });
      for (const view of views) {
        const { page, context, errors } = await open({
          who: view.who,
          width,
          theme,
          scale,
          path: view.path,
        });
        await ready(page, view.wait);
        if (view.name.startsWith('project')) await page.waitForTimeout(300);
        if (view.name === 'project-preview') await sampleShown(page);
        const found = await overflow(page);
        const shot = `${view.name}-${width}-${theme}-${scale}.png`;
        await page.screenshot({ path: join(shots, shot) });
        matrix.push({ shot, ...found, errors });
        if (view.name === 'project') {
          // The symbol table, scrolled into view in its own column (or the page on narrow screens).
          await page.locator('[aria-label="Symbols and rules"]').scrollIntoViewIfNeeded();
          await page
            .locator('h2:has-text("Format")')
            .evaluate((el) => el.scrollIntoView({ block: 'start' }));
          const symbolShot = `format-${width}-${theme}-${scale}.png`;
          await page.screenshot({ path: join(shots, symbolShot) });
          matrix.push({ shot: symbolShot, ...(await overflow(page)), errors });
        }
        await context.close();
      }
    }
results.renderQa = matrix;
const failures = matrix.filter(
  (row) =>
    row.page > 0 ||
    row.wide.length ||
    row.clipped.length ||
    row.overlap.length ||
    row.tall.length ||
    row.errors.length,
);
writeFileSync(join(out, 'exports-browser.json'), JSON.stringify(results, null, 2));
log(`Render QA: ${matrix.length} screenshots, ${failures.length} with findings`);
for (const row of failures) log(JSON.stringify(row));
await finish();
process.exit(failures.length ? 1 : 0);

async function finish() {
  await browser.close();
  await server.close();
  site.close();
  child.kill();
}
