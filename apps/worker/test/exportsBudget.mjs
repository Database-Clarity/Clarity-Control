// CPU/subrequest proxy for the /exports routes (export spec section 4, P3 gate), cold and warm, in
// Node and in local workerd. Run from the repo root (under bench_lock for decisive numbers):
//   node apps/worker/test/exportsBudget.mjs [output.json]
// Cold = the first request of a fresh isolate (a new Node process or a new `wrangler dev`) for
// each route, 5 isolates per route (median and max); warm = the next 10 requests of each.
// Real Workers CPU is verified after deploy (root).
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const bundle = '.wrangler/exports-local.mjs';
const warmRuns = 10;
/** Fresh isolates per route; cold is reported as their median and max. */
const isolates = 5;
const routes = [
  'list-maintainer',
  'list-partner',
  'get-project',
  'create',
  'update',
  'partners',
  'delete',
  'me',
  'baseline-permissions',
];
const MAINTAINER = 1;
const PARTNER = 1000;

/** One request of `route`, iteration `i`; `call` sends it (measured unless `setup`). */
async function step(route, i, call) {
  const revision = async (id) => await (await call('GET', `/__revision?id=${id}`)).json();
  switch (route) {
    case 'list-maintainer':
      return call('GET', '/exports/projects', undefined, MAINTAINER, true);
    case 'list-partner':
      return call('GET', '/exports/projects', undefined, PARTNER, true);
    case 'baseline-permissions':
      // An existing route (unchanged by this task) for comparison: head + contents + schema.
      return call('GET', '/permissions', undefined, MAINTAINER, true);
    case 'get-project':
      return call('GET', '/exports/projects?project=project-0', undefined, PARTNER, true);
    case 'me':
      return call('GET', '/me', undefined, PARTNER, true);
    case 'create': {
      // 3 style files with new categories (one category fetch), at 39 -> 40 projects.
      // Setup and cleanup go to the mock directly, so the measured POST is the isolate's first.
      await call('POST', '/__drop?id=project-39');
      const files = [0, 1, 2].map((f) => ({
        id: `file-${f}`,
        formatVersion: 1,
        preset: 'markdown',
        shape: 'text',
        data: {
          categories: Array.from({ length: 20 }, (_, c) => `category-${c}`),
          sandboxPerks: ['category-1'],
          frameAliases: true,
          languages: ['en', 'de'],
          keys: ['name', 'itemHash'],
          bungieIdentical: false,
        },
        format: {
          symbols: { bold: { mode: 'replace', before: '**', after: '**' } },
          titles: { mode: 'drop' },
          links: { mode: 'drop' },
          elementTags: false,
          spacer: 'keep',
        },
      }));
      const id = `new-project-${i}`;
      return call(
        'POST',
        '/exports/projects',
        { config: { schema: 1, id, name: id, files } },
        MAINTAINER,
        true,
        async () => {
          await call('POST', `/__drop?id=${id}`);
        },
      );
    }
    case 'update': {
      // Odd runs add a category (one category fetch), even runs remove it.
      const { revision: rev, config } = await revision('project-0');
      const data = config.files[0].data;
      data.categories =
        i % 2 === 0
          ? [...data.categories, 'category-50']
          : data.categories.filter((c) => c !== 'category-50');
      return call('PUT', '/exports/projects/project-0', { revision: rev, config }, PARTNER, true);
    }
    case 'partners': {
      // Even runs add a new login (one account lookup), odd runs remove it.
      const { revision: rev } = await revision('permissions');
      const logins = i % 2 === 0 ? ['partner0', `newcomer${i}`] : ['partner0'];
      return call(
        'PUT',
        '/exports/projects/project-0/partners',
        { revision: rev, logins },
        MAINTAINER,
        true,
      );
    }
    case 'delete': {
      const id = `project-${i + 1}`;
      return call(
        'DELETE',
        `/exports/projects/${id}`,
        { revision: (await revision(id)).revision },
        MAINTAINER,
        true,
      );
    }
  }
  throw new Error(route);
}

/** Runs one route cold + warm against `send(method, path, body, token)`; returns rows. */
async function measureRoute(route, send) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  await send('POST', '/__configure', key);
  const tokens = new Map();
  for (const id of [MAINTAINER, PARTNER])
    tokens.set(id, (await (await send('GET', `/__token?id=${id}`)).json()).token);
  const rows = [];
  for (let i = 0; i <= warmRuns; i++) {
    let row;
    const call = async (method, path, body, id, measured = false, after) => {
      const start = performance.now();
      const response = await send(
        method,
        path,
        body === undefined ? undefined : JSON.stringify(body),
        id && tokens.get(id),
      );
      const text = await response.text();
      if (measured) {
        if (!response.ok) throw new Error(`${route} #${i}: ${response.status} ${text}`);
        row = {
          route,
          run: i === 0 ? 'cold' : 'warm',
          status: response.status,
          end_to_end_ms: +(performance.now() - start).toFixed(3),
          handler_proxy_ms: +Number(response.headers.get('X-Local-Handler-Proxy-Ms')).toFixed(3),
          upstream_awaited_ms: +Number(response.headers.get('X-Local-Upstream-Awaited-Ms')).toFixed(
            3,
          ),
          subrequests: Number(response.headers.get('X-Local-Subrequests')),
        };
        if (after) await after();
      }
      return new Response(text, response);
    };
    await step(route, i, call);
    rows.push(row);
  }
  return rows;
}

function summarise(rows) {
  const out = [];
  for (const route of routes) {
    const cold = rows.filter((r) => r.route === route && r.run === 'cold');
    const warm = rows.filter((r) => r.route === route && r.run === 'warm');
    const median = (list, key) => {
      const values = list.map((r) => r[key]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const max = (list, key) => Math.max(...list.map((r) => r[key]));
    out.push({
      route,
      isolates: cold.length,
      cold_handler_median_ms: median(cold, 'handler_proxy_ms'),
      cold_handler_max_ms: max(cold, 'handler_proxy_ms'),
      cold_end_to_end_median_ms: median(cold, 'end_to_end_ms'),
      warm_handler_median_ms: median(warm, 'handler_proxy_ms'),
      warm_handler_max_ms: max(warm, 'handler_proxy_ms'),
      warm_end_to_end_median_ms: median(warm, 'end_to_end_ms'),
      subrequests_max: max([...cold, ...warm], 'subrequests'),
    });
  }
  return out;
}

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, args, { windowsHide: true, maxBuffer: 1 << 24 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

if (process.argv[2] === '--child') {
  // Node: a fresh process per route, so its first request is cold.
  const { default: worker } = await import(pathToFileURL(bundle).href);
  const env = JSON.parse(process.argv[4]);
  const send = (method, path, body, token) =>
    worker.fetch(
      new Request(`https://api.example${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
      env,
      { waitUntil() {} },
    );
  process.stdout.write(JSON.stringify(await measureRoute(process.argv[3], send)));
} else {
  const esbuild = await import('esbuild');
  mkdirSync('.wrangler', { recursive: true });
  await esbuild.build({
    entryPoints: ['apps/worker/test/exportsLocal.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    outfile: bundle,
    logLevel: 'warning',
  });
  const vars = {
    SITE_ORIGIN: 'https://editor.example',
    SITE_URL: 'https://editor.example/app/',
    GITHUB_OWNER: 'Database-Clarity',
    GITHUB_REPO: 'Live-Clarity-Database',
    DATA_BRANCH: 'editor-data',
    LIVE_BRANCH: 'converter-v2-test',
    GENERATOR_OWNER: 'Database-Clarity',
    GENERATOR_REPO: 'Description-data-generator',
    GENERATOR_BRANCH: 'v2',
    GITHUB_APP_ID: '1',
    GITHUB_APP_SLUG: 'clarity-local',
    GITHUB_INSTALLATION_ID: '2',
    GITHUB_CLIENT_ID: 'c',
    GITHUB_CLIENT_SECRET: 's',
    OAUTH_CALLBACK_URL: 'https://api.example/auth/callback',
  };
  const node = [];
  for (let n = 0; n < isolates; n++)
    for (const route of routes)
      node.push(
        ...JSON.parse(
          await run(['apps/worker/test/exportsBudget.mjs', '--child', route, JSON.stringify(vars)]),
        ),
      );
  const workerd = [];
  for (let n = 0; n < isolates; n++)
    for (const route of routes) {
      const port = 5200 + routes.indexOf(route);
      const child = spawn(
        process.execPath,
        [
          'node_modules/wrangler/bin/wrangler.js',
          'dev',
          bundle,
          '--config',
          'apps/worker/wrangler.jsonc',
          '--no-bundle',
          '--local',
          '--port',
          String(port),
          '--ip',
          '127.0.0.1',
          '--inspector-port',
          '0',
          '--persist-to',
          `.wrangler/exports-perf-${randomUUID()}`,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('Wrangler readiness timeout')), 60000);
          child.once('exit', (code) => reject(new Error(`Wrangler exited ${code}`)));
          child.stdout.on('data', (data) => {
            output += data;
            if (output.includes('Ready on http')) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        const send = (method, path, body, token) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body === undefined ? {} : { body }),
          });
        workerd.push(...(await measureRoute(route, send)));
      } finally {
        await new Promise((resolve) =>
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () =>
            resolve(),
          ),
        );
      }
    }
  const result = {
    label: 'proxy; real CPU verified after deploy (root)',
    method:
      'handler_proxy_ms = wall time minus awaited upstream fetch spans (mocked in-process GitHub); workerd clock moves only on I/O, so its end_to_end_ms (client side, includes the mock and local HTTP) is the conservative workerd figure',
    data: '40 projects x 3 style files, 40 partners, 25 users, 60 categories',
    node: { summary: summarise(node), rows: node },
    workerd: { summary: summarise(workerd), rows: workerd },
  };
  const output = process.argv[2] ?? '.wrangler/exports-budget.json';
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ node: result.node.summary, workerd: result.workerd.summary }, null, 2),
  );
}
