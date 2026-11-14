// LOCAL CPU gate for the scheduled-batch Worker paths (spec "Free-plan budget", phase P2; root
// 2026-11-13: local only, the remote clarity-publisher-cpu-preview run is OPEN for P5).
// The real Worker bundle (switches ON) runs in Node against a synthetic, never-changing head
// built from the 100 largest real tooltips (editor-data at REAL_COMMIT, cached under dist/).
// Per case: one cold invocation, 20 warm-up, then 200 timed invocations (worst accepted
// payloads). The spec's gate was p99 < 8 ms; root 2026-11-13 made it relative: each case's p99
// must be at most the p99 of the existing /publish at 100 hashes (remote-accepted) in the SAME
// run. If a case fails, lower a cap, never a check. Decisive runs go through the measurement
// queue (quiet machine).
//
// node scripts/publisher/cpu/schedule.mjs [--prepared] [case,...]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REAL_COMMIT = '6ac370e349edcaba526a9f413995eb2b574738e1';
// The generator's aliases.json (~150 KB) that every save and schedule loads.
const GENERATOR_COMMIT = '1354e3a8c5cd4e16bf40e136fbdaa966f4dd2a32';
// The 100 largest non-global tooltips at REAL_COMMIT by blob size (2,027 down to 1,253 bytes).
const REAL = [
  3993379141, 3640170453, 798520364, 83039194, 1694242448, 3891536761, 988980154, 2984351207,
  3495263107, 1667892710, 569260333, 2120661319, 1602994571, 921817150, 1017906546, 229534486,
  3824622015, 1331592343, 2731901709, 2881100038, 1070100196, 1133590731, 89777927, 1149655156,
  2321824287, 127335543, 3418782618, 2651551055, 1920417385, 2031919264, 187655375, 3066103996,
  117669763, 1731450287, 4094452600, 4185339856, 619537267, 1341199512, 187655372, 1640501529,
  2445247031, 1919923227, 622433369, 262821312, 3966416502, 3066103997, 692285813, 214670074,
  2890807135, 2321824285, 1860418166, 1667892708, 228577175, 858592012, 3874977694, 365154968,
  928399924, 2710254013, 1844314558, 3324494224, 4251375227, 3458099662, 489583097, 2618534366,
  2204713148, 2179914730, 1656549672, 4015745376, 2041432007, 3100590152, 902934539, 3441203855,
  2540536653, 1449897497, 4019266109, 1888882410, 218281600, 961505134, 3295796664, 1971489086,
  3642491337, 3866705246, 1807646319, 2984351205, 1095471953, 2663272110, 489583096, 164468655,
  1870851715, 578605621, 1969105489, 1656549674, 1818108773, 3723531833, 2094939076, 2894608781,
  1385166695, 1630940558, 460017080, 299272945,
];
const GLOBALS = [0, 1, 2, 3];
const LANGS = [
  'de',
  'es',
  'es-mx',
  'fr',
  'it',
  'ja',
  'ko',
  'pl',
  'pt-br',
  'ru',
  'zh-chs',
  'zh-cht',
];
// `kind:N` runs a kind at N members per batch; default: the Worker's cap (memberCap).
// The save kinds also take a `-sched` suffix (a scheduled target batch).
const KINDS = [
  'list',
  'create',
  'save-edit',
  'save-edit-cap',
  'save-max',
  'save-add',
  'schedule',
  'schedule-cap',
  'unschedule',
  'resolve',
  'cron',
  'kick',
  'publish-conflicts',
  'publish-baseline',
];
const CASES = KINDS;
/** The generator aliases of the running case (child only). */
let ALIASES = {};
/** The batch members of the running case (the first N of REAL). */
let MEMBERS = REAL;
const out = resolve('scripts/publisher/cpu/dist/schedule');
const ID = '01K95H00000000000000000B01';
const OP = '01K95H00000000000000000P01';
const alice = { id: 1, login: 'cpu' };

async function realTooltips() {
  const cache = resolve(out, 'real');
  mkdirSync(cache, { recursive: true });
  const all = {};
  for (const hash of [...GLOBALS, ...REAL]) {
    const file = resolve(cache, `${hash}.json`);
    if (!existsSync(file)) {
      const url = `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${REAL_COMMIT}/tooltips/${hash}.json`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      writeFileSync(file, await response.text());
    }
    all[hash] = JSON.parse(readFileSync(file, 'utf8'));
  }
  // The real live/pushed.json (~2,500 entries) and generator aliases, cached beside them.
  for (const [name, url] of [
    [
      'pushed.json',
      `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${REAL_COMMIT}/live/pushed.json`,
    ],
    [
      'aliases.json',
      `https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/${GENERATOR_COMMIT}/templates/v2/aliases.json`,
    ],
  ]) {
    const file = resolve(cache, name);
    if (existsSync(file)) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(file, await response.text());
  }
  return all;
}

async function prepare() {
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: ['scripts/publisher/cpu/schedule-entry.mjs'],
    outfile: `${out}/worker.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    inject: ['scripts/publisher/cpu/schedule-upstream.mjs'],
    logLevel: 'error',
    plugins: [
      {
        name: 'switches-on',
        setup(b) {
          b.onLoad({ filter: /config[\\/](publisher|scheduled)\.json$/ }, () => ({
            contents: '{"enabled":true}',
            loader: 'json',
          }));
        },
      },
    ],
  });
  const pem = (type) =>
    generateKeyPairSync(type, type === 'rsa' ? { modulusLength: 2048 } : {})
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  const secret = randomBytes(32).toString('hex');
  const value = Buffer.from(
    JSON.stringify({
      id: 1,
      login: 'cpu',
      purpose: 'session',
      exp: Math.floor(Date.now() / 1000) + 86400,
    }),
  ).toString('base64url');
  writeFileSync(
    `${out}/env.json`,
    JSON.stringify({
      env: {
        SITE_ORIGIN: 'https://cpu.invalid',
        GITHUB_OWNER: 'cpu',
        GITHUB_REPO: 'fixture',
        DATA_BRANCH: 'cpu-data',
        LIVE_BRANCH: 'cpu-live',
        GENERATOR_OWNER: 'cpu',
        GENERATOR_REPO: 'generator',
        GENERATOR_BRANCH: 'v2',
        GITHUB_APP_ID: '1',
        GITHUB_APP_SLUG: 'cpu',
        GITHUB_INSTALLATION_ID: '1',
        GITHUB_PRIVATE_KEY: pem('rsa'),
        PUBLISH_SIGNING_KEY: pem('ed25519'),
        SESSION_SECRET: secret,
      },
      token: `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`,
    }),
  );
  await realTooltips();
}

// ---------------------------------------------------------------------------------- child ---
const stamp = '2026-11-01T00:00:00Z';
const text = (value) => ({ text: value, updatedAt: stamp, updatedBy: 'cpu' });
const withLang = (tooltip, lang, value) => ({
  ...tooltip,
  text: { ...tooltip.text, [lang]: text(value) },
});
const bytes = (value) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);

/** A proposal translated into every language, padded so its member file is just under `cap`. */
function capped(base, cap) {
  const english = base.text.en?.text ?? 'text';
  const fill = (n) => {
    let proposed = withLang(base, 'en', `${english} (upcoming)`);
    for (const lang of LANGS) proposed = withLang(proposed, lang, `${english} `.repeat(n));
    return proposed;
  };
  const member = (proposed) => ({
    hash: base.hash,
    base,
    baseCommit: 'a'.repeat(40),
    proposed,
    updatedAt: '2026-11-01T00:01:00.000Z',
    updatedBy: 'cpu',
  });
  let low = 0;
  let high = 64;
  while (bytes(member(fill(high))) < cap) high *= 2;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (bytes(member(fill(mid))) < cap) low = mid;
    else high = mid;
  }
  // Fill the remaining bytes in the last language so the file lands within 64 bytes of the cap.
  let proposed = fill(low);
  const last = LANGS.at(-1);
  const spare = cap - bytes(member(proposed)) - 64;
  if (spare > 0) proposed = withLang(proposed, last, proposed.text[last].text + 'x'.repeat(spare));
  return member(proposed);
}

function event(action, hashes, revision = 2) {
  return {
    at: stamp,
    by: alice,
    action,
    revision,
    contentRevision: 1,
    ...(hashes ? { hashes } : {}),
  };
}

function batch(overrides = {}) {
  return {
    id: ID,
    name: 'December release with a long enough name to be realistic',
    createdBy: alice,
    createdAt: stamp,
    revision: 2,
    contentRevision: 1,
    status: 'draft',
    notBefore: null,
    zone: null,
    opId: null,
    scheduledContentRevision: null,
    claim: null,
    result: null,
    // Worst inline history: 200 events naming 100 hashes each; the next write overflows.
    events: Array.from({ length: 200 }, () => event('save', MEMBERS)),
    ...overrides,
  };
}

function ulid(n) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let tail = '';
  for (let i = 0, rest = n; i < 6; i++, rest = Math.floor(rest / 32))
    tail = alphabet[rest % 32] + tail;
  return `01K95H0000000000000${tail.slice(-7).padStart(7, '0')}`;
}

async function state(name, real, lib) {
  // `<kind>-sched` runs a save kind against a SCHEDULED batch: translation-only saves that also
  // read the live snapshots and pushed.json and compose every member (round-2 code review).
  const sched = name.split(':')[0].endsWith('-sched');
  const kind = name.split(':')[0].replace(/-sched$/, '');
  const files = new Map();
  const put = (path, value) => files.set(path, value);
  put('config/permissions.json', { users: { 1: { login: 'cpu', role: 'maintainer' } } });
  put('.publisher/PIN', { capabilities: ['elementTags', 'scheduledBatches'] });
  for (const hash of GLOBALS) put(`tooltips/${hash}.json`, real[hash]);
  const pushed = JSON.parse(readFileSync(resolve(out, 'real', 'pushed.json'), 'utf8'));
  for (const hash of REAL) {
    put(`tooltips/${hash}.json`, real[hash]);
    put(`live/tooltips/${hash}.json`, real[hash]);
    pushed[hash] ??= await lib.publishableHash(real[hash], ALIASES);
  }
  put('live/pushed.json', pushed);
  // Full index (50 open + 100 terminal, 100 hashes each) and a full due.json.
  const others = Array.from({ length: 149 }, (_, i) => ulid(i + 1));
  put('schedule/index.json', {
    batches: [ID, ...others].slice(0, kind === 'create' ? 149 : 150).map((id, i) => ({
      id,
      name: `Batch ${i}`,
      status: i < (kind === 'create' ? 49 : 50) ? 'draft' : 'cancelled',
      notBefore: null,
      opId: null,
      revision: 2,
      hashes: [...MEMBERS].sort((a, b) => a - b),
      updatedAt: stamp,
    })),
  });
  put('schedule/due.json', {
    // Full for the cron; 49 others elsewhere, so scheduling the target is still admitted.
    entries: Array.from({ length: kind === 'cron' ? 50 : 49 }, (_, i) => ({
      batchId: others[i],
      opId: ulid(1000 + i),
      notBefore: '2026-11-01T00:00:00.000Z',
      claimed: i % 2 === 0,
    })),
  });
  // 149 other batch directories, each naming 100 members (the Q2 listing), cancelled; the
  // save-add case lets HOLDERS of them hold the added hashes, with full histories.
  // save-add:N:H lets H cancelled batches with full histories hold the added hashes (default 10).
  const holders = kind === 'save-add' ? Number(name.split(':')[2] ?? 10) : 0;
  for (const [i, id] of others.entries()) {
    put(
      `schedule/batches/${id}/batch.json`,
      i < holders ? batch({ id, status: 'cancelled' }) : { id },
    );
    // Non-holders list 100 other members, so the listing stays full but Q2 reads only holders.
    for (const [j, hash] of MEMBERS.entries())
      put(
        `schedule/batches/${id}/tooltips/${i < holders ? hash : 4100000000 + i * 100 + j}.json`,
        {},
      );
  }
  put(`schedule/batches/${ID}/events/00000000.json`, { events: [event('create', undefined, 1)] });
  const cap = kind.endsWith('-cap');
  const members = MEMBERS.map((hash) =>
    cap
      ? capped(real[hash], lib.memberByteCap)
      : {
          hash,
          base: real[hash],
          baseCommit: 'a'.repeat(40),
          proposed: withLang(real[hash], 'en', `${real[hash].text.en?.text ?? ''} (upcoming)`),
          updatedAt: '2026-11-01T00:01:00.000Z',
          updatedBy: 'cpu',
        },
  );
  if (kind !== 'save-add')
    for (const member of members)
      put(`schedule/batches/${ID}/tooltips/${member.hash}.json`, member);
  let target = sched
    ? batch({
        status: 'scheduled',
        opId: OP,
        notBefore: '2026-12-01T00:00:00.000Z',
        zone: 'Europe/Berlin',
        scheduledContentRevision: 1,
      })
    : batch();
  if (kind === 'unschedule' || kind === 'kick')
    target = batch({
      status: 'scheduled',
      opId: OP,
      notBefore: '2026-11-01T00:00:00.000Z',
      zone: 'Europe/Berlin',
      scheduledContentRevision: 1,
    });
  if (kind === 'unschedule')
    put(`publish/requests/${OP}.json`, {
      payload: JSON.stringify({ intentDigest: 'a'.repeat(64) }),
      sig: 'a'.repeat(88),
    });
  if (kind === 'resolve') {
    const big = real[REAL[0]];
    const base = big;
    const proposed = withLang(
      withLang(big, 'en', `${big.text.en.text} (upcoming)`),
      'de',
      'Kommend',
    );
    const current = withLang(big, 'en', `${big.text.en.text} (edited meanwhile)`);
    put(`tooltips/${big.hash}.json`, current);
    put(`schedule/activation-conflicts/${big.hash}.json`, {
      hash: big.hash,
      batchId: ID,
      opId: OP,
      fields: ['text.en'],
      changed: ['text.en', 'text.de'],
      base,
      proposed,
      currentAtRecord: current,
    });
    target = batch({
      status: 'published',
      opId: OP,
      notBefore: '2026-11-01T00:00:00.000Z',
      zone: 'UTC',
      scheduledContentRevision: 1,
      claim: { opId: OP, claimedAt: stamp },
      result: {
        opId: OP,
        status: 'published',
        landedAt: stamp,
        landedAtSource: 'cas',
        recordedAt: stamp,
        exportNow: stamp,
        liveCommit: 'a'.repeat(40),
      },
    });
  }
  if (kind === 'publish-conflicts')
    // publish-conflicts:N: N unresolved conflict files (default 1,000), a names-only listing.
    for (let i = 0; i < Number(name.split(':')[1] ?? 1000); i++)
      put(`schedule/activation-conflicts/${4000000000 + i}.json`, {});
  put(`schedule/batches/${ID}/batch.json`, target);
  return { files, members };
}

async function request(name, real, members, lib) {
  const minute = new Date(Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000).toISOString();
  switch (name.split(':')[0].replace(/-sched$/, '')) {
    case 'list':
      return { method: 'GET', path: '/batches', status: 200 };
    case 'create':
      return { path: '/batches', body: { name: 'New batch' }, status: 201 };
    case 'save-edit':
    case 'save-edit-cap': {
      // As many changes as the 2 MB body cap accepts (all 100 for real-size members).
      const changes = [];
      for (const member of members) {
        const change = {
          hash: member.hash,
          base: member.proposed,
          next: withLang(member.proposed, 'de', `${member.proposed.text.de?.text ?? ''}!`),
        };
        if (bytes({ revision: 2, changes: [...changes, change], message: 'x' }) > 1_900_000) break;
        changes.push(change);
      }
      return {
        path: `/batches/${ID}/save`,
        body: { revision: 2, changes, message: 'Stage translations' },
        status: 200,
        note: `${changes.length} changes`,
      };
    }
    case 'save-max': {
      // The largest admissible save body (just under the 300 KiB cap): every change carries an
      // obsolete field in both base and next that the merge drops, so it is accepted (200).
      const shaped = (n) =>
        members.map((member) => {
          const base = withLang(member.proposed, 'fr', 'x'.repeat(n));
          return { hash: member.hash, base, next: withLang(base, 'de', 'Kommend') };
        });
      const size = (n) => bytes({ revision: 2, changes: shaped(n), message: 'Stage' });
      let n = 0;
      while (size(n + 256) < 300 * 1024 - 512) n += 256;
      return {
        path: `/batches/${ID}/save`,
        body: { revision: 2, changes: shaped(n), message: 'Stage' },
        status: 200,
        note: `${members.length} changes`,
      };
    }
    case 'save-add':
      return {
        path: `/batches/${ID}/save`,
        body: {
          revision: 2,
          changes: MEMBERS.map((hash) => ({
            hash,
            base: real[hash],
            next: withLang(real[hash], 'en', `${real[hash].text.en?.text ?? ''} (upcoming)`),
          })),
          message: 'Stage',
        },
        status: 200,
      };
    case 'schedule':
    case 'schedule-cap':
      return {
        path: `/batches/${ID}/schedule`,
        body: { revision: 2, notBefore: minute, zone: 'Europe/Berlin' },
        status: 202,
      };
    case 'unschedule':
      return { path: `/batches/${ID}/unschedule`, body: { revision: 2 }, status: 200 };
    case 'kick':
      return { path: `/batches/${ID}/kick`, body: {}, status: 202 };
    case 'resolve': {
      const current = withLang(
        real[REAL[0]],
        'en',
        `${real[REAL[0]].text.en.text} (edited meanwhile)`,
      );
      return {
        path: `/batches/${ID}/resolve`,
        body: {
          hash: REAL[0],
          expectedCurrent: await lib.contentHash(current),
          choices: { 'text.en': 'current' },
        },
        status: 200,
      };
    }
    case 'publish-baseline':
    case 'publish-conflicts': {
      const hashes = REAL;
      const expected = {};
      for (const hash of hashes) expected[hash] = await lib.publishableHash(real[hash], ALIASES);
      // A fresh opId per process (the creation window is +-24 h); the state never records it.
      const t = Date.now();
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let prefix = '';
      for (let i = 0, rest = t; i < 10; i++, rest = Math.floor(rest / 32))
        prefix = alphabet[rest % 32] + prefix;
      return {
        path: '/publish',
        body: { opId: `${prefix}0000000000000000`, hashes, expected },
        status: 202,
      };
    }
  }
  return undefined;
}

async function child(name) {
  globalThis.fetch = () => {
    throw new Error('External I/O escaped CPU harness');
  };
  const lib = await import(pathToFileURL(`${out}/worker.mjs`).href);
  const { env, token } = JSON.parse(readFileSync(`${out}/env.json`, 'utf8'));
  MEMBERS = REAL.slice(0, Number(name.split(':')[1] ?? lib.memberCap));
  const real = {};
  for (const hash of [...GLOBALS, ...REAL])
    real[hash] = JSON.parse(readFileSync(resolve(out, 'real', `${hash}.json`), 'utf8'));
  ALIASES = JSON.parse(readFileSync(resolve(out, 'real', 'aliases.json'), 'utf8'));
  const { files, members } = await state(name, real, lib);
  globalThis.__scheduleCpu = { files, aliases: ALIASES };
  const spec = name.startsWith('cron') ? null : await request(name, real, members, lib);
  const bodyText = spec?.body === undefined ? undefined : JSON.stringify(spec.body);
  const invoke = async () => {
    if (!spec) {
      const result = await lib.scheduleTick(env);
      if (result.status !== 'kicked') throw new Error(`cron: ${JSON.stringify(result)}`);
      return;
    }
    const response = await lib.default.fetch(
      new Request(`https://cpu.invalid${spec.path}`, {
        method: spec.method ?? 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(bodyText === undefined ? {} : { body: bodyText }),
      }),
      env,
      { waitUntil() {} },
    );
    const text = await response.text();
    if (response.status !== spec.status)
      throw new Error(`${name}: ${response.status} ${text.slice(0, 400)}`);
  };
  // Windows process.cpuUsage ticks at ~15.6 ms, so each call is timed by wall clock (an upper
  // bound of its CPU here: the harness never waits on I/O), and CPU is cross-checked as the mean
  // over 20-call batches.
  const timed = async () => {
    const start = performance.now();
    await invoke();
    return performance.now() - start;
  };
  console.log = () => {};
  const cold = await timed();
  for (let i = 0; i < 20; i++) await invoke();
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push(await timed());
  const means = [];
  for (let batch = 0; batch < 10; batch++) {
    const start = process.cpuUsage();
    for (let i = 0; i < 20; i++) await invoke();
    const used = process.cpuUsage(start);
    means.push((used.user + used.system) / 1000 / 20);
  }
  samples.sort((a, b) => a - b);
  means.sort((a, b) => a - b);
  const rank = (p) => samples[Math.ceil(samples.length * p) - 1];
  process.stdout.write(
    JSON.stringify({
      case: name,
      ...(spec?.note ? { note: spec.note } : {}),
      requestBytes: bodyText ? Buffer.byteLength(bodyText) : 0,
      coldMs: +cold.toFixed(2),
      p50: +rank(0.5).toFixed(2),
      p95: +rank(0.95).toFixed(2),
      p99: +rank(0.99).toFixed(2),
      max: +samples.at(-1).toFixed(2),
      cpuMeanMax: +means.at(-1).toFixed(2),
    }),
  );
}

if (process.argv[2] === '--case') {
  await child(process.argv[3]);
} else {
  // `--prepared` reuses the bundle built by an earlier run (measured runs do no build).
  const prepared = process.argv[2] === '--prepared';
  const list = prepared ? process.argv[3] : process.argv[2];
  const wanted = list ? list.split(',') : [...CASES];
  // The baseline always runs: the existing /publish at 100 hashes, accepted by the remote gate.
  if (!wanted.includes('publish-baseline')) wanted.unshift('publish-baseline');
  if (!prepared) await prepare();
  const rows = [];
  for (const name of wanted) {
    if (!KINDS.includes(name.split(':')[0].replace(/-sched$/, '')))
      throw new Error(`Unknown case ${name}`);
    rows.push(
      JSON.parse(
        execFileSync(process.execPath, [import.meta.filename, '--case', name], {
          encoding: 'utf8',
          maxBuffer: 64 << 20,
        }),
      ),
    );
    console.log(JSON.stringify(rows.at(-1)));
  }
  // Root 2026-11-13 (option A): relative gate. Every case's local p99 must be at most the
  // baseline's p99 in the SAME run (local 8 ms is about remote 3-4 ms on this machine).
  const limit = rows.find((row) => row.case === 'publish-baseline').p99;
  const failed = rows.filter((row) => row.case !== 'publish-baseline' && row.p99 > limit);
  writeFileSync(
    `${out}/summary.json`,
    `${JSON.stringify({ limit, rows }, null, 2)}
`,
  );
  console.log(
    failed.length
      ? `FAIL ${failed.map((row) => row.case).join(', ')} (p99 over the publish-100 baseline ${limit} ms)`
      : `PASS (every p99 <= the publish-100 baseline p99 ${limit} ms)`,
  );
  if (failed.length) process.exitCode = 1;
}
