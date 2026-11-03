// Remote CPU gate on the dedicated throwaway Worker's ACTIVE deployment (runbook "CPU preview gate",
// E2A "Root decision (run 6)"). One isolated attempt per case: fresh bundle/keys/token in its own
// directory, one deploy, one tail confirmed ready before the first request, paced requests, then
// Workers Logs (authoritative, per sampleId) polled until every sent sample is present.
//
// node scripts/publisher/cpu/gate.mjs <evidence-dir> [mode:size,...]
// Requires CLOUDFLARE_ACCOUNT_ID, wrangler auth (deploy/tail) and cf CLI auth (Workers Logs query).
import { spawn, spawnSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WORKER = 'clarity-publisher-cpu-preview';
const PACE_MS = 400;
const TAIL_READY_MS = 60_000;
const LOGS_WAIT_MS = 300_000;
const STALE_WAIT_MS = 120_000;
const WARM = 20;
const evidence = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: gate.mjs <evidence-dir> [mode:size,...]');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[0-9a-f]{32}$/.test(account ?? '')) throw Error('Set CLOUDFLARE_ACCOUNT_ID');
if (process.env.CPU_BASELINE) throw Error('CPU_BASELINE must be unset');
const ALL = ['publish', 'pending', 'terminal', 'kick'].flatMap((mode) =>
  [1, 50, 100, ...(mode === 'terminal' ? [2511] : [])].map((size) => ({ mode, size })),
);
const cases = process.argv[3]
  ? process.argv[3].split(',').map((c) => {
      const [mode, size] = c.split(':');
      return { mode, size: Number(size) };
    })
  : ALL;
const wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
const cfJs =
  process.env.CF_CLI_JS ??
  path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'cf', 'bin', 'cf');
if (!fs.existsSync(wrangler) || !fs.existsSync(cfJs)) throw Error('wrangler or cf CLI missing');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(evidence, { recursive: true });
const log = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  fs.appendFileSync(path.join(evidence, 'gate.log'), stamped + '\n');
};

function run(args, file, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 << 20,
  });
  fs.writeFileSync(file, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (r.error || r.status !== 0) throw Error(`Command failed (${r.status}); see ${file}`);
  return r.stdout;
}

function guardConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const allowed = ['name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls'];
  const extra = Object.keys(config).filter(
    (k) => ![...allowed, 'observability', 'vars'].includes(k),
  );
  if (config.name !== WORKER || extra.length) throw Error(`Unexpected target/config: ${extra}`);
  config.workers_dev = true;
  config.observability = {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Workers Logs: join the invocation event (header sample id, cpuTimeMs, outcome, status) to the
// entry.mjs console line (isolate, invocation, build) through $metadata.requestId.
function queryLogs(dir, version, from, n) {
  const filters = path.join(dir, 'logs-filter.json');
  fs.writeFileSync(
    filters,
    JSON.stringify([
      { key: '$workers.scriptVersion.id', operation: 'eq', type: 'string', value: version },
    ]),
  );
  const out = run(
    [
      cfJs,
      'o11y',
      'telemetry',
      'query',
      '--query-id',
      `cpugate-${version}`,
      '--view',
      'events',
      '--limit',
      '1000',
      '--timeframe-from',
      String(from),
      '--timeframe-to',
      String(Date.now() + 60_000),
      '--parameters-filters',
      `@${filters}`,
    ],
    path.join(dir, `logs-export-${n}.json`),
    { CLOUDFLARE_ACCOUNT_ID: account },
  );
  const events = JSON.parse(out).events?.events ?? [];
  if (events.length >= 1000) throw Error('Workers Logs page full; paginate');
  const byRequest = new Map();
  for (const e of events) {
    const id = e.$metadata?.requestId;
    const entry = byRequest.get(id) ?? {};
    const w = e.$workers ?? {};
    if (w.cpuTimeMs !== undefined) {
      entry.sampleId = w.event?.request?.headers?.['x-cpu-sample'];
      entry.cpuTime = w.cpuTimeMs;
      entry.wallTime = w.wallTimeMs;
      entry.outcome = w.outcome;
      entry.status = w.event?.response?.status;
    } else if (typeof e.source === 'object' && 'invocation' in e.source) {
      Object.assign(entry, {
        logSample: e.source.cpuSample,
        isolate: e.source.isolate,
        invocation: e.source.invocation,
        build: e.source.build,
      });
    }
    byRequest.set(id, entry);
  }
  return [...byRequest.entries()].map(([requestId, r]) => ({ requestId, ...r, version }));
}

function parseTail(file) {
  const input = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const out = [];
  let depth = 0,
    quoted = false,
    escaped = false,
    start = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{' && depth++ === 0) start = i;
    else if (c === '}' && --depth === 0) out.push(JSON.parse(input.slice(start, i + 1)));
  }
  return out;
}

const stats = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const rank = (p) => v[Math.ceil(v.length * p) - 1];
  return { n: v.length, p50: rank(0.5), p95: rank(0.95), max: v.at(-1) };
};

async function attempt({ mode, size }, n) {
  const dir = path.join(evidence, `${mode}-${size}-attempt${n}`);
  if (fs.existsSync(dir)) throw Error(`Refusing to reuse ${dir}`);
  const out = path.join(dir, 'dist');
  fs.mkdirSync(out, { recursive: true });
  run(['scripts/publisher/cpu/prepare.mjs', mode, String(size)], path.join(dir, 'prepare.log'), {
    CPU_OUT: out,
  });
  const configPath = path.join(out, 'wrangler.json');
  guardConfig(configPath);
  const client = JSON.parse(fs.readFileSync(path.join(out, 'client.json'), 'utf8'));
  const from = Date.now() - 60_000;
  const deployed = run([wrangler, 'deploy', '--config', configPath], path.join(dir, 'deploy.log'));
  const version = /Current Version ID: ([a-f0-9-]+)/.exec(deployed)?.[1];
  const base = /(https:\/\/clarity-publisher-cpu-preview\.[a-z0-9-]+\.workers\.dev)/.exec(
    deployed,
  )?.[1];
  if (!version || !base) throw Error('No version id / workers.dev URL in deploy output');
  log(`${mode}/${size} attempt ${n}: deployed ${version} build ${client.build}`);

  // One tail per attempt, its own debug directory, readiness only from this session.
  const debugDir = path.join(dir, 'tail-debug');
  fs.mkdirSync(debugDir);
  const tailPath = path.join(dir, 'tail.json');
  const fd = fs.openSync(tailPath, 'w');
  const tail = spawn(
    process.execPath,
    [wrangler, 'tail', WORKER, '--config', configPath, '--version-id', version, '--format', 'json'],
    { env: { ...env, WRANGLER_LOG_PATH: debugDir }, stdio: ['ignore', fd, fd], windowsHide: true },
  );
  fs.closeSync(fd);
  const sent = [];
  let telemetry = [];
  let logsComplete = false;
  try {
    const readyBy = Date.now() + TAIL_READY_MS;
    let ready = false;
    while (!ready && Date.now() < readyBy) {
      if (tail.exitCode !== null) throw Error(`Tail exited ${tail.exitCode}`);
      ready = fs
        .readdirSync(debugDir)
        .some((f) =>
          /Received pong|Connected to/.test(fs.readFileSync(path.join(debugDir, f), 'utf8')),
        );
      if (!ready) await sleep(500);
    }
    if (!ready) throw Error('Tail not ready');
    log(`${mode}/${size} attempt ${n}: tail ready`);

    const url = new URL(
      mode === 'publish' ? '/publish' : mode === 'kick' ? '/publish/kick' : '/publish/status',
      base,
    );
    const posting = mode === 'publish' || mode === 'kick';
    let seq = 0;
    const send = async (role) => {
      await sleep(PACE_MS);
      const op = opId();
      const target = new URL(url);
      if (!posting) target.searchParams.set('opId', op);
      const sampleId = `${version}-${role}-${mode}-${size}-${seq++}`;
      const response = await fetch(target, {
        method: posting ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${client.token}`,
          'Content-Type': 'application/json',
          'X-CPU-Sample': sampleId,
        },
        ...(posting
          ? {
              body: JSON.stringify(
                mode === 'publish'
                  ? { opId: op, hashes: client.hashes, expected: client.expected }
                  : { opId: op },
              ),
            }
          : {}),
      });
      const body = await response.text();
      const record = {
        sampleId,
        role,
        status: response.status,
        build: response.headers.get('x-cpu-build'),
        invocation: Number(response.headers.get('x-cpu-invocation')),
        at: Date.now(),
      };
      record.current = record.build === client.build;
      if (!record.current) record.role = 'stale';
      else if (response.status !== (posting ? 202 : 200)) record.error = body.slice(0, 300);
      sent.push(record);
      fs.appendFileSync(path.join(dir, 'samples.jsonl'), JSON.stringify(record) + '\n');
      if (record.error)
        throw Object.assign(Error(`HARD FAIL ${sampleId}: ${response.status} ${body}`), {
          hard: true,
        });
      return record;
    };
    // Cold: the first request that lands on THIS deployment. Responses from the previous
    // deployment (still propagating) are recorded as stale and do not count.
    const staleBy = Date.now() + STALE_WAIT_MS;
    while (!(await send('cold')).current) {
      if (Date.now() > staleBy) throw Error('New deployment never served');
      await sleep(2000);
    }
    let warm = 0;
    let primed = false;
    while (warm < WARM) {
      const r = await send(primed ? 'warm' : 'prime');
      if (!r.current) continue;
      if (primed) warm++;
      primed = true;
    }
    log(
      `${mode}/${size} attempt ${n}: sent ${sent.length} (${sent.filter((s) => !s.current).length} stale)`,
    );

    const wanted = sent.filter((s) => s.current).map((s) => s.sampleId);
    const deadline = Date.now() + LOGS_WAIT_MS;
    for (let q = 1; Date.now() < deadline; q++) {
      await sleep(q === 1 ? 15_000 : 10_000);
      telemetry = queryLogs(dir, version, from, q);
      const seen = new Set(
        telemetry
          .filter((t) => t.sampleId && t.isolate && Number.isFinite(t.cpuTime))
          .map((t) => t.sampleId),
      );
      const missing = wanted.filter((s) => !seen.has(s));
      if (!missing.length) {
        logsComplete = true;
        break;
      }
      log(`${mode}/${size} attempt ${n}: Workers Logs missing ${missing.length}`);
    }
  } finally {
    tail.kill();
    await new Promise((r) =>
      tail.exitCode !== null ? r() : (tail.once('exit', r), setTimeout(r, 3000)),
    );
  }

  const bySample = new Map(telemetry.filter((t) => t.sampleId).map((t) => [t.sampleId, t]));
  const tailRows = parseTail(tailPath)
    .filter((e) => e.scriptVersion?.id === version)
    .map((e) => ({
      sampleId: e.event?.request?.headers?.['x-cpu-sample'],
      cpuTime: e.cpuTime,
      outcome: e.outcome,
    }));
  const rows = sent
    .filter((s) => s.current)
    .map((s) => ({ ...s, ...bySample.get(s.sampleId), role: s.role, clientStatus: s.status }));
  fs.writeFileSync(
    path.join(dir, 'normalized.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const unexpected = telemetry.filter(
    (t) => t.sampleId && !sent.some((s) => s.sampleId === t.sampleId),
  );
  const coldRow = rows.find((r) => r.role === 'cold');
  const warmRows = rows.filter((r) => r.role === 'warm');
  const tailMismatch = tailRows.filter(
    (t) => bySample.get(t.sampleId) && bySample.get(t.sampleId).cpuTime !== t.cpuTime,
  );
  const summary = {
    mode,
    size,
    attempt: n,
    version,
    build: client.build,
    sent: sent.length,
    stale: sent.filter((s) => !s.current).length,
    logsComplete,
    tailCaptured: tailRows.filter((t) => rows.some((r) => r.sampleId === t.sampleId)).length,
    tailCpuMismatches: tailMismatch.length,
    foreignRequestsOnVersion: telemetry.filter((t) => !t.sampleId).length,
    cold: coldRow && {
      cpuTime: coldRow.cpuTime,
      invocation: coldRow.invocation,
      outcome: coldRow.outcome,
    },
    warm: {
      ...stats(warmRows.map((r) => r.cpuTime).filter(Number.isFinite)),
      isolates: new Set(warmRows.map((r) => r.isolate)).size,
    },
    prime: rows.find((r) => r.role === 'prime')?.cpuTime,
  };
  summary.complete =
    logsComplete &&
    !unexpected.length &&
    coldRow?.invocation === 1 &&
    warmRows.length === WARM &&
    summary.warm.n === WARM &&
    warmRows.every((r) => r.invocation > 1);
  summary.hardPass = rows.every(
    (r) =>
      r.clientStatus >= 200 &&
      r.clientStatus < 300 &&
      (!r.outcome || r.outcome === 'ok') &&
      (!r.status || r.status === r.clientStatus),
  );
  summary.coldFlag = (coldRow?.cpuTime ?? 0) > 25;
  summary.cpuPass = summary.warm.p95 < 7;
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.rmSync(path.join(out, 'wrangler.json')); // throwaway private keys; bundle stays as evidence
  return summary;
}

function opId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now(),
    s = '';
  for (let i = 0; i < 10; i++) {
    s = alphabet[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return (
    s +
    randomUUID()
      .replaceAll('-', '')
      .slice(0, 16)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
  );
}

const results = [];
let verdict = 'PASS';
try {
  for (const c of cases) {
    let summary;
    for (let n = 1; n <= 2; n++) {
      summary = await attempt(c, n);
      log(JSON.stringify(summary));
      if (!summary.hardPass)
        throw Object.assign(Error(`HARD FAIL ${c.mode}/${c.size}`), { hard: true });
      if (summary.complete) break;
      log(`${c.mode}/${c.size} incomplete on attempt ${n}`);
    }
    results.push(summary);
    if (!summary.complete) verdict = verdict === 'HARD FAIL' ? verdict : 'INCOMPLETE';
    else if (c.size <= 50 && !summary.cpuPass) verdict = verdict === 'PASS' ? 'FAIL' : verdict;
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  }
} catch (e) {
  verdict = e.hard ? 'HARD FAIL' : 'ERROR';
  fs.writeFileSync(path.join(evidence, 'failure.txt'), `${e.stack}\n`);
  log(e.message);
}
const table = results.map(
  (r) =>
    `| ${r.mode} | ${r.size} | ${r.cold?.cpuTime ?? 'n/a'}${r.coldFlag ? ' (flag)' : ''} | ${r.warm.p50}/${r.warm.p95}/${r.warm.max} (n${r.warm.n}) | ${r.complete ? 'complete' : 'INCOMPLETE'} a${r.attempt} |`,
);
fs.writeFileSync(
  path.join(evidence, 'table.md'),
  [
    '| Mode | Size | Cold ms | Warm p50/p95/max ms | Telemetry |',
    '|---|---|---|---|---|',
    ...table,
    '',
    `Verdict: ${verdict}`,
  ].join('\n') + '\n',
);
log(`VERDICT ${verdict}`);
if (verdict !== 'PASS') process.exitCode = 1;
