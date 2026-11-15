// Offline workerd CPU probe. Prepare through heavy.py, then measure through bench_lock.py.
// node apps/worker/test/saveCpu.bench.ts prepare|smoke|measure [baseline|candidate]
// Uses the schedule gate's real fixtures, immutable head, cached upstream, and process CPU
// method. Process CPU includes runtime/harness work; it is not hosted invocation CPU.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Lang, Tooltip } from '@clarity/core';

const root = resolve('scripts/publisher/cpu/dist');
let mode = process.argv[2];
const arm = process.argv[3] ?? 'baseline';
const names = [
  'save-small-en',
  'save-small-de',
  'save-largest-en',
  'save-largest-de',
  'save-add',
  'publish-baseline',
  'push-live-single',
  'push-live-largest',
  'push-live-real',
];
const measuredNames = process.env.SAVE_CPU_CASES?.split(',') ?? names;
type Spec = {
  path: string;
  body: { changes?: { base: Tooltip; next: Tooltip }[]; hashes?: number[] };
  status: number;
};
type Fixture = { files: [string, unknown][]; spec: Spec };

async function prepare() {
  mkdirSync(root, { recursive: true });
  mkdirSync(`${root}/generator`, { recursive: true });
  const inputs = [
    [
      'corpus.tar.gz',
      'https://api.github.com/repos/Database-Clarity/Live-Clarity-Database/tarball/41245f1c2b6de42097b5bdd112ef784d7562fe66',
    ],
    ...['items.json', 'categories.json', 'aliases.json', 'sandboxConflicts.json'].map((file) => [
      `generator/${file}`,
      `https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/8b8eeb67/templates/v2/${file}`,
    ]),
  ];
  for (const [file, url] of inputs)
    if (!existsSync(`${root}/${file}`)) {
      const response = await fetch(url);
      if (!response.ok) throw Error(`${url}: ${response.status}`);
      writeFileSync(`${root}/${file}`, Buffer.from(await response.arrayBuffer()));
    }
  await build({
    stdin: {
      contents:
        "export * from '@clarity/core'; export {refuseTaggedEntries} from './apps/worker/src/elementTags.ts';",
      resolveDir: process.cwd(),
    },
    outfile: `${root}/core-${arm}.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'error',
  });
  const core = await import(pathToFileURL(`${root}/core-${arm}.mjs`).href);
  const corpus = resolve(root, 'corpus');
  mkdirSync(corpus, { recursive: true });
  execFileSync('tar', ['-xf', `${root}/corpus.tar.gz`, '--strip-components=1', '-C', corpus], {
    windowsHide: true,
  });
  const current: Tooltip[] = readdirSync(`${corpus}/tooltips`)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${corpus}/tooltips/${f}`, 'utf8')));
  const largest = current
    .filter((t) => t.hash > 3 && t.text.en?.text)
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
  // Reuse the existing fixture builders without running their Node timing driver.
  let source = readFileSync('scripts/publisher/cpu/schedule.mjs', 'utf8');
  source = source.slice(0, source.indexOf("if (process.argv[2] === '--case')"));
  source +=
    '\nexport {prepare,state,request,REAL,GLOBALS}; export function configure(aliases,lib){ ALIASES=aliases; MEMBERS=REAL.slice(0,lib.memberCap); }';
  writeFileSync(`${root}/save-fixtures.mjs`, source);
  const f = await import(pathToFileURL(`${root}/save-fixtures.mjs`).href);
  await f.prepare();
  const lib = await import(pathToFileURL(`${root}/schedule/worker.mjs`).href);
  const real = Object.fromEntries(
    [...f.REAL, ...f.GLOBALS].map((h: number) => [
      h,
      JSON.parse(readFileSync(`${root}/schedule/real/${h}.json`, 'utf8')),
    ]),
  );
  const aliases = JSON.parse(readFileSync(`${root}/schedule/real/aliases.json`, 'utf8'));
  const generator = Object.fromEntries(
    ['items.json', 'categories.json', 'aliases.json', 'sandboxConflicts.json'].map((file) => [
      file,
      readFileSync(`${root}/generator/${file}`, 'utf8'),
    ]),
  );
  const items = JSON.parse(generator['items.json']);
  const { env, token } = JSON.parse(readFileSync(`${root}/schedule/env.json`, 'utf8'));
  f.configure(aliases, lib);
  const fixtures: Record<string, Fixture> = {};
  for (const name of names) {
    const { files, members } = await f.state(
      name === 'publish-baseline' ? name : 'save-add',
      real,
      lib,
    );
    files.set('.publisher/PIN', {
      capabilities: [
        'elementTags',
        'scheduledBatches',
        'markupBraces',
        'numberTokens',
        'sandboxPointers',
      ],
    });
    let spec: Spec;
    if (name.startsWith('save-small') || name.startsWith('save-largest')) {
      const base: Tooltip = structuredClone(largest);
      if (name.startsWith('save-small'))
        base.text = { en: { ...base.text.en!, text: 'Damage 5.' } };
      const lang = name.endsWith('-de') ? 'de' : 'en';
      const next = structuredClone(base);
      next.text[lang] = {
        ...base.text.en!,
        text: base.text.en!.text + '!',
        updatedAt: new Date().toISOString(),
        ...(lang === 'de' ? { sourceUpdatedAt: base.text.en!.updatedAt } : {}),
      };
      files.set(`tooltips/${base.hash}.json`, base);
      spec = { path: '/save', body: { changes: [{ base, next }] }, status: 200 };
      Object.assign(spec.body, { message: 'CPU probe' });
      Object.assign(spec.body.changes![0], { hash: base.hash });
    } else if (name.startsWith('push-live')) {
      let selected = name.endsWith('single')
        ? current.filter((t) => t.hash === 1168162263)
        : current.filter((t) => t.hash > 3 && t.text.en?.text && (items[t.hash] || t.custom));
      if (name.endsWith('real'))
        selected = selected.filter((t) => {
          try {
            core.refuseTaggedEntries(core.exportLegacy([t], Date.now()));
            return true;
          } catch {
            return false;
          }
        });
      else
        selected = selected.map((t) => ({
          ...t,
          text: {
            en: {
              text: 'Canonical benchmark text',
              updatedAt: '2025-01-01T00:00:00Z',
              updatedBy: 'alice',
            },
          },
        }));
      if (!selected.length) throw Error('Push fixture is empty');
      for (const t of current) files.set(`tooltips/${t.hash}.json`, t);
      for (const t of selected) files.set(`tooltips/${t.hash}.json`, t);
      console.log(`Push fixture ${name}: ${selected.length} selected hashes, absent alias config.`);
      files.set('liveDescriptions.json', { perks: {}, databaseSettings: {} });
      spec = { path: '/push-live', body: { hashes: selected.map((t) => t.hash) }, status: 200 };
    } else spec = await f.request(name, real, members, lib);
    for (const c of spec.body.changes ?? []) {
      if (c.next.text.en?.text !== c.base.text.en?.text)
        c.next.text.en!.updatedAt = new Date().toISOString();
    }
    fixtures[name] = { files: [...files], spec };
  }
  writeFileSync(
    `${root}/save-data.json`,
    JSON.stringify({ fixtures, aliases, generator, env, token }),
  );
  const upstream = readFileSync('scripts/publisher/cpu/schedule-upstream.mjs', 'utf8').replace(
    'export async function fetch(input, init) {',
    `export async function fetch(input, init) { globalThis.__saveCount++;
 if(globalThis.__lastSaveName!==globalThis.__saveName){cache.clear();globalThis.__lastSaveName=globalThis.__saveName;}
 const u=new URL(String(input));
 if(u.pathname.includes('/git/ref/heads/'))return Response.json({object:{sha:'a'.repeat(40)}});
 if(u.pathname.includes('/git/commits/') && (!init?.method || init.method==='GET'))return Response.json({tree:{sha:'a'.repeat(40)}});
 if(u.pathname.includes('/contents/') && (!init?.method || init.method==='GET')){
   const path=decodeURIComponent(u.pathname.split('/contents/')[1]);
   let body=cache.get(path);
   if(body===undefined){
     const value=globalThis.__scheduleCpu.files.get(path);
     if(value===undefined)return new Response('',{status:404});
     const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';
     for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
     body=JSON.stringify({sha:'a'.repeat(40),encoding:'base64',content:btoa(binary)});
     cache.set(path,body);
   }
   return new Response(body,{headers:{'Content-Type':'application/json'}});
 }
 if(u.hostname==='raw.githubusercontent.com' && globalThis.__saveName.startsWith('push-live')){
   const value=globalThis.__saveGenerator[u.pathname.split('/').at(-1)];
   if(value!==undefined)return new Response(value,{headers:{'Content-Type':'application/json'}});
 }
 if(u.pathname==='/repos/cpu/fixture/contents/liveDescriptions.json' && init?.method==='PUT'){
   if(globalThis.__saveExportRows===undefined){const s=JSON.parse(init.body).content;const bytes=Uint8Array.from(atob(s),c=>c.charCodeAt(0));globalThis.__saveExportRows=Object.keys(JSON.parse(new TextDecoder().decode(bytes)).perks).length;}
   return Response.json({commit:{sha:'a'.repeat(40)}},{status:200});
 }`,
  );
  writeFileSync(`${root}/save-upstream.mjs`, upstream);
  writeFileSync(
    `${root}/save-entry.mjs`,
    `import worker from '../schedule-entry.mjs';
import publisherConfig from '../../../../config/publisher.json';
import data from './save-data.json';
export default {async fetch(req){
 const name=new URL(req.url).pathname.slice(1), f=data.fixtures[name];
 publisherConfig.enabled=!name.startsWith('push-live');
 if(globalThis.__saveName!==name){globalThis.__scheduleCpu={files:new Map(f.files),aliases:data.aliases};globalThis.__saveName=name;globalThis.__saveGenerator=data.generator;globalThis.__saveEnv={...data.env};globalThis.__saveExportRows=undefined;}
 globalThis.__saveCount=0;
 const s=f.spec;
 const r=await worker.fetch(new Request('https://cpu.invalid'+s.path,{method:'POST',headers:{Authorization:'Bearer '+data.token,'Content-Type':'application/json'},body:JSON.stringify(s.body)}),globalThis.__saveEnv,{waitUntil(){}});
 const body=await r.text(); if(r.status!==s.status)throw Error(name+': '+r.status+' '+body);
 return Response.json({status:r.status,subrequests:globalThis.__saveCount,exportRows:globalThis.__saveExportRows});
}};`,
  );
  await build({
    entryPoints: [`${root}/save-entry.mjs`],
    outfile: `${root}/save-${arm}.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    inject: [`${root}/save-upstream.mjs`],
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
  console.log(
    `Prepared ${arm}: real schedule fixtures, four ordinary save cases, largest hash ${largest.hash} (${JSON.stringify(largest).length} UTF-16 units).`,
  );
}

async function census() {
  const core: typeof import('@clarity/core') = await import(
    pathToFileURL(`${root}/core-${arm}.mjs`).href
  );
  const corpus = resolve(root, 'corpus');
  mkdirSync(corpus, { recursive: true });
  execFileSync('tar', ['-xf', `${root}/corpus.tar.gz`, '--strip-components=1', '-C', corpus], {
    windowsHide: true,
  });
  const tooltips: Tooltip[] = readdirSync(`${corpus}/tooltips`)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${corpus}/tooltips/${f}`, 'utf8')));
  const byHash = new Map(tooltips.map((t) => [t.hash, t]));
  const globalsFor = (lang: Lang) => ({
    variables: (byHash.get(2)?.text[lang] ?? byHash.get(2)?.text.en)?.text ?? '',
    titles: (byHash.get(3)?.text[lang] ?? byHash.get(3)?.text.en)?.text ?? '',
    imports: Object.fromEntries(
      tooltips.map((t) => [t.hash, (t.text[lang] ?? t.text.en)?.text ?? '']),
    ),
  });
  const globals = new Map(core.languages.map((lang) => [lang, globalsFor(lang)]));
  let texts = 0;
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const rows: Record<string, string> = {};
  for (const tooltip of tooltips) {
    const scans = Object.entries(tooltip.text).map(([lang, entry]) => {
      texts++;
      return [
        lang,
        core.numberSlots(entry.text, tooltip.hash),
        core.markupCommentContext(entry.text),
        entry.text.split('\n').map((line) => core.markupInlineRanges(line)),
      ];
    });
    rows[tooltip.hash] = digest([
      scans,
      core.validateTooltip(tooltip, (lang) => globals.get(lang)!),
      core.validateTooltip(tooltip, (lang) => globals.get(lang)!, tooltip),
    ]);
  }
  const result = {
    source: 'editor-data 41245f1c2b6de42097b5bdd112ef784d7562fe66',
    tooltips: tooltips.length,
    texts,
    rows,
  };
  writeFileSync(`${root}/census-${arm}.json`, JSON.stringify(result));
  if (arm !== 'baseline') {
    const baseline = JSON.parse(readFileSync(`${root}/census-baseline.json`, 'utf8'));
    const changed = Object.keys(rows).filter((hash) => rows[hash] !== baseline.rows[hash]);
    if (changed.length || texts !== baseline.texts)
      throw Error('VERDICT IDENTITY FAIL: ' + changed.join(','));
  }
  console.log(
    `CENSUS ${arm} PASS: ${tooltips.length} tooltips, ${texts} language texts, slots, comments, inline ranges, and save verdicts.`,
  );
}

function summarizeProfiles() {
  type Profile = {
    nodes: {
      id: number;
      callFrame: { functionName: string; lineNumber: number };
      children?: number[];
    }[];
    samples: number[];
    timeDeltas: number[];
  };
  const rows = [];
  for (const name of measuredNames) {
    const profile: Profile = JSON.parse(readFileSync(`${root}/${arm}-${name}.cpuprofile`, 'utf8'));
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const parents = new Map<number, number>();
    for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n.id);
    const self: Record<string, number> = {},
      inclusive: Record<string, number> = {};
    for (const [i, id] of profile.samples.entries()) {
      const node = nodes.get(id)!,
        elapsed = profile.timeDeltas[i];
      const frame = node.callFrame.functionName || `(anonymous):${node.callFrame.lineNumber + 1}`;
      self[frame] = (self[frame] ?? 0) + elapsed;
      const stack = new Set<string>();
      for (let at: number | undefined = id; at !== undefined; at = parents.get(at))
        stack.add(nodes.get(at)!.callFrame.functionName);
      for (const f of stack) inclusive[f] = (inclusive[f] ?? 0) + elapsed;
    }
    const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
    const top = (values: Record<string, number>) =>
      Object.entries(values)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([f, micros]) => ({ f, percent: +((micros / total) * 100).toFixed(2) }));
    const row = {
      name,
      topSelf: top(self),
      topInclusive: top(inclusive),
      numberSlotsPercent: +(((inclusive.numberSlots ?? 0) / total) * 100).toFixed(2),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(`${root}/profiles-${arm}.json`, JSON.stringify(rows, null, 2));
}

async function measure() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: `${root}/save-${arm}.mjs`,
      compatibilityDate: '2025-11-01',
      port: 0,
      ...(mode === 'profile' ? { inspectorPort: 0 } : {}),
    }),
  );
  const ps = (cmd: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const rows = [];
  try {
    await mf.ready;
    if (mode === 'profile') {
      const inspector = await mf.getInspectorURL();
      const targets = await (
        await fetch(new URL('/json/list', String(inspector).replace('ws:', 'http:')))
      ).json();
      const ws = new WebSocket(
        targets.find((t: { id: string }) => t.id.includes('user')).webSocketDebuggerUrl,
      );
      await new Promise((ok, fail) => {
        ws.onopen = ok;
        ws.onerror = fail;
      });
      let id = 0;
      const pending = new Map<number, (value: { profile: unknown }) => void>();
      ws.onmessage = (event) => {
        const m = JSON.parse(String(event.data));
        if (m.error) throw Error(JSON.stringify(m.error));
        pending.get(m.id)?.(m.result);
        pending.delete(m.id);
      };
      const post = (method: string) =>
        new Promise<{ profile: unknown }>((ok) => {
          pending.set(++id, ok);
          ws.send(JSON.stringify({ id, method }));
        });
      try {
        await post('Profiler.enable');
        for (const name of measuredNames) {
          const invoke = async () => {
            const r = await mf.dispatchFetch('http://localhost/' + name);
            const text = await r.text();
            if (r.status !== 200) throw Error(text);
          };
          for (let i = 0; i < 10; i++) await invoke();
          await post('Profiler.start');
          for (let i = 0; i < 100; i++) await invoke();
          const { profile } = await post('Profiler.stop');
          writeFileSync(`${root}/${arm}-${name}.cpuprofile`, JSON.stringify(profile));
          console.log(`PROFILE ${arm} ${name}`);
        }
      } finally {
        ws.close();
      }
      return;
    }
    const ids = ps(
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Where-Object Name -eq 'workerd.exe' | Select-Object -ExpandProperty ProcessId`,
    )
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length !== 1) throw Error('Expected one workerd child, got ' + ids);
    const cpu = () =>
      Number(ps(`(Get-Process -Id ${ids[0]}).TotalProcessorTime.TotalMilliseconds`));
    for (const name of measuredNames) {
      let subrequests = 0;
      let exportRows: number | undefined;
      const invoke = async () => {
        const r = await mf.dispatchFetch('http://localhost/' + name);
        const body = await r.text();
        if (r.status !== 200) throw Error(body);
        const result = JSON.parse(body);
        subrequests = result.subrequests;
        exportRows = result.exportRows;
        if (subrequests > 50) throw Error('Subrequest cap exceeded');
      };
      const cold = performance.now();
      await invoke();
      const coldWallMs = performance.now() - cold;
      if (mode !== 'smoke') for (let i = 0; i < 10; i++) await invoke();
      const n = mode === 'smoke' ? 1 : 100,
        start = cpu(),
        samples = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await invoke();
        samples.push(performance.now() - t);
      }
      const meanWorkerdCpuMs = (cpu() - start) / n;
      samples.sort((a, b) => a - b);
      const row = {
        name,
        n,
        subrequests,
        exportRows,
        meanWorkerdCpuMs,
        coldWallMs,
        wallP99Ms: samples[Math.ceil(n * 0.99) - 1],
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    if (mode !== 'smoke')
      writeFileSync(
        `${root}/save-${arm}-results.json`,
        JSON.stringify(
          {
            note: 'Workerd process CPU includes runtime/harness work; not hosted invocation CPU.',
            rows,
          },
          null,
          2,
        ),
      );
  } finally {
    await mf.dispose();
  }
}

if (mode === 'prepare') await prepare();
else if (mode === 'census') await census();
else if (mode === 'summarize') summarizeProfiles();
else if (mode === 'capture') {
  mode = 'measure';
  await measure();
  mode = 'profile';
  await measure();
} else if (mode === 'smoke' || mode === 'measure' || mode === 'profile') await measure();
else throw Error('Expected prepare, smoke, or measure');
