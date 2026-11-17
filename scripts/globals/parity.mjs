// Offline adapter gate. Spec binds the export clock, contexts, engine/source pins, and all
// adapter dependencies by SHA-256. Each adapter exports convert(input, frozenContext).
// node scripts/globals/parity.mjs spec.json before.json after.json output-directory
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const legacy = [
  'braytech',
  'clarity',
  'crayon',
  'dim',
  'foundry',
  'lightGG',
  'vaultZero',
  'clarityV2',
];
const installedFiles = [...legacy, 'structured', 'markdown', 'discord', 'plain'].map(
  (file) => `${file}.json`,
);
export async function parity(spec, before, after, out) {
  if (!Number.isSafeInteger(spec.now) || spec.now < 0 || !/^[a-f0-9]{64}$/.test(spec.planSha256))
    throw new Error('Pin the clock and migration plan');
  if (existsSync(out))
    throw new Error('Preserve existing parity evidence; choose a fresh output directory');
  if (
    spec.adapters.length !== 2 ||
    spec.adapters[0].role !== 'installed' ||
    spec.adapters[1].role !== 'held'
  )
    throw new Error('Require installed and independent held engines');
  const reports = [];
  mkdirSync(out, { recursive: true });
  for (const adapter of spec.adapters) {
    for (const pin of [adapter, ...adapter.dependencies]) {
      if (!/^[a-f0-9]{64}$/.test(pin.sha256) || digest(readFileSync(pin.path)) !== pin.sha256)
        throw new Error('Adapter/dependency byte pin mismatch');
    }
    if (
      !adapter.sourceCommits.length ||
      adapter.sourceCommits.some((commit) => !/^[a-f0-9]{40}$/.test(commit))
    )
      throw new Error('Exact adapter source commits required');
    const { convert } = await import(pathToFileURL(resolve(adapter.path)).href);
    const a = await convert(structuredClone(before), structuredClone(spec.context));
    const b = await convert(structuredClone(after), structuredClone(spec.context));
    const expected =
      adapter.role === 'installed' ? installedFiles : legacy.map((file) => `${file}.json`);
    for (const result of [a, b])
      if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...expected].sort()))
        throw new Error(`Incomplete ${adapter.role} consumer output set`);
    const files = [];
    for (const file of expected) {
      const bytes = (value) => {
        if (typeof value !== 'string' && !(value instanceof Uint8Array))
          throw new Error('Adapter must return serialized bytes');
        return Buffer.from(value);
      };
      const left = bytes(a[file]),
        right = bytes(b[file]);
      let differingBytes = Math.abs(left.length - right.length),
        firstDifference = null;
      for (let i = 0; i < Math.min(left.length, right.length); i++)
        if (left[i] !== right[i]) {
          differingBytes++;
          firstDifference ??= i;
        }
      if (firstDifference === null && left.length !== right.length)
        firstDifference = Math.min(left.length, right.length);
      for (const [side, value] of [
        ['before', left],
        ['after', right],
      ]) {
        const directory = join(out, adapter.role, side);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, file), value);
      }
      files.push({
        file,
        beforeSha256: digest(left),
        afterSha256: digest(right),
        beforeBytes: left.length,
        afterBytes: right.length,
        differingBytes,
        firstDifference,
      });
    }
    reports.push({ role: adapter.role, sourceCommits: adapter.sourceCommits, files });
  }
  const report = {
    version: 1,
    planSha256: spec.planSha256,
    now: spec.now,
    beforeInputSha256: digest(JSON.stringify(before)),
    afterInputSha256: digest(JSON.stringify(after)),
    spec,
    reports,
    identical: reports.every((r) => r.files.every((f) => f.differingBytes === 0)),
  };
  writeFileSync(join(out, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.identical) throw new Error('Consumer byte difference: STOP; inspect parity.json');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [spec, before, after, out] = process.argv.slice(2);
    if (!out)
      throw new Error('Usage: parity.mjs spec.json before.json after.json output-directory');
    const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const result = await parity(read(spec), read(before), read(after), resolve(out));
    process.stdout.write(
      `${JSON.stringify({ identical: result.identical, outputs: result.reports.map((r) => [r.role, r.files.length]) })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
