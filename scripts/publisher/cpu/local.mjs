// Local process CPU and V8 profile; synthetic upstream, no network or deployment.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import inspector from 'node:inspector';
import { maxBuffer } from '../childProcess.mjs';

const out = `scripts/publisher/cpu/dist/local-${process.env.CPU_BASELINE === '1' ? 'before' : 'after'}`;
process.env.CPU_OUT = out;
if (process.argv[2] !== 'case') {
  const rows = [];
  for (const mode of ['publish', 'pending', 'terminal', 'kick']) {
    for (const count of [1, 50, 100, 2511]) {
      execFileSync(process.execPath, ['scripts/publisher/cpu/prepare.mjs', mode, String(count)], {
        maxBuffer,
      });
      rows.push(
        JSON.parse(execFileSync(process.execPath, [import.meta.filename, 'case'], { maxBuffer })),
      );
    }
  }
  writeFileSync(`${out}/local-summary.json`, JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
} else {
  globalThis.fetch = () => {
    throw new Error('External I/O escaped CPU harness');
  };
  const { default: worker } = await import(pathToFileURL(resolve(`${out}/worker.mjs`)));
  const { vars: env } = JSON.parse(readFileSync(`${out}/wrangler.json`));
  const { mode, count, token, hashes, expected } = JSON.parse(readFileSync(`${out}/client.json`));
  const session = new inspector.Session();
  session.connect();
  const post = (method) =>
    new Promise((resolve, reject) =>
      session.post(method, (error, result) => (error ? reject(error) : resolve(result))),
    );
  await post('Profiler.enable');
  const invoke = async () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = Date.now(),
      prefix = '';
    for (let i = 0; i < 10; i++) {
      prefix = alphabet[t % 32] + prefix;
      t = Math.floor(t / 32);
    }
    const opId = prefix + '0000000000000000';
    const sending = mode === 'publish' || mode === 'kick';
    const path =
      mode === 'publish'
        ? '/publish'
        : mode === 'kick'
          ? '/publish/kick'
          : `/publish/status?opId=${opId}`;
    const response = await worker.fetch(
      new Request(`https://cpu.invalid${path}`, {
        method: sending ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(sending
          ? { body: JSON.stringify(mode === 'publish' ? { opId, hashes, expected } : { opId }) }
          : {}),
      }),
      env,
      { waitUntil() {} },
    );
    if (response.status !== (sending ? 202 : 200)) throw new Error(await response.text());
    await response.text();
  };
  console.log = () => {};
  const measure = async () => {
    const start = process.cpuUsage();
    for (let i = 0; i < 20; i++) await invoke();
    const elapsed = process.cpuUsage(start);
    return (elapsed.user + elapsed.system) / 1000 / 20;
  };
  const coldStart = performance.now();
  await invoke();
  const coldWallMs = performance.now() - coldStart;
  for (let i = 0; i < 20; i++) await invoke();
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push(await measure());
  // Profile separately to avoid including inspector overhead in timings.
  await post('Profiler.start');
  for (let i = 0; i < 200; i++) await invoke();
  const { profile } = await post('Profiler.stop');
  session.disconnect();
  writeFileSync(`${out}/${mode}-${count}.cpuprofile`, JSON.stringify(profile));
  samples.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      mode,
      count,
      coldWallMs,
      batchSize: 20,
      p50: samples[14],
      p95: samples[28],
      max: samples[29],
    }),
  );
}
