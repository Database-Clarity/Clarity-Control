import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
// Export a normalized JSONL from Workers Logs. Never substitute wall time or tail duration.
const groups = new Map();
for (const r of rows) {
  if (!Number.isFinite(r.cpuTime) || !r.sampleId || !r.isolate || !Number.isInteger(r.invocation))
    throw new Error('Missing cpuTime/sampleId/isolate/invocation');
  if (r.sampleId.endsWith('-prime')) continue;
  const m = /-(cold|warm)-(publish|pending|terminal|kick)-(1|100|2511)-\d+$/.exec(r.sampleId);
  if (!m) throw new Error('Invalid sample id');
  if (m[1] === 'cold' && r.invocation !== 1) throw new Error('Cold sample reused isolate');
  if (m[1] === 'warm' && r.invocation === 1) throw new Error('Warm sample is cold');
  const key = m.slice(1).join('/');
  groups.set(key, [...(groups.get(key) || []), r]);
}
let pass = true;
for (const temp of ['cold', 'warm'])
  for (const mode of ['publish', 'pending', 'terminal', 'kick'])
    for (const n of [1, 100, 2511]) {
      const key = `${temp}/${mode}/${n}`,
        g = groups.get(key) || [],
        values = g.map((r) => r.cpuTime).sort((a, b) => a - b);
      if (g.length !== 20 || new Set(g.map((r) => r.sampleId)).size !== 20)
        throw new Error(`Need exactly 20 unique samples: ${key}`);
      if (temp === 'cold' && new Set(g.map((r) => r.isolate)).size !== 20)
        throw new Error('Need distinct cold isolates');
      if (temp === 'warm' && new Set(g.map((r) => r.isolate)).size !== 1)
        throw new Error('Warm group crossed isolates; repeat');
      const p99 = values[Math.ceil(values.length * 0.99) - 1];
      console.log(`${key} p99=${p99} ms`);
      pass &&= p99 < 7;
    }
if (!pass) process.exitCode = 1;
