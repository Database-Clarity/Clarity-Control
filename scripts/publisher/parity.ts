/** Read-only parity at frozen receipt inputs; converter adapters must be independently pinned. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  exportLegacy,
  publishableHash,
  type Tooltip,
  type LegacyFacts,
  type Aliases,
} from '../../packages/core/src/index.js';
import { stampUploads } from '../../apps/worker/src/stamp.js';
const [repo, commit, receiptPath, configPath, adapterPath, outArg] = process.argv.slice(2);
if (!outArg)
  throw new Error(
    'Usage: parity.mjs repo liveCommit receiptPath config.json converter-adapters.mjs outputDir',
  );
const git = (...args: string[]) =>
  execFileSync('git', ['-C', resolve(repo), ...args], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
const read = (ref: string, path: string) => JSON.parse(git('show', `${ref}:${path}`));
const receipt = read(commit, receiptPath);
if (!/^[a-f0-9]{40}$/.test(commit) || !receiptPath.startsWith('.publish/receipts/'))
  throw new Error('Exact test live commit and receipt required');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  facts: Record<string, LegacyFacts>;
  aliases: Aliases;
  generatorSha: string;
};
if (config.generatorSha !== receipt.generatorSha)
  throw new Error('Generator pin differs from receipt');
const base = read(receipt.liveParent, 'liveDescriptions.json');
const actual = git('show', `${commit}:liveDescriptions.json`);
const tooltips: Tooltip[] = receipt.entries.map((e: { tooltipBlob: string }) =>
  JSON.parse(git('cat-file', 'blob', e.tooltipBlob)),
);
for (let i = 0; i < tooltips.length; i++)
  if ((await publishableHash(tooltips[i])) !== receipt.entries[i].digest)
    throw new Error('Receipt digest mismatch');
const exported = exportLegacy(tooltips, receipt.now, config.facts, config.aliases);
const request = read(receipt.sourceCommit, `publish/requests/${receipt.opId}.json`);
const requester = JSON.parse(request.payload).requester;
stampUploads(exported, new Set<number>(receipt.changed), base.perks, receipt.now, requester.login);
const expected = JSON.stringify({ ...base, perks: { ...base.perks, ...exported } }, null, 2) + '\n';
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'expected-liveDescriptions.json'), expected);
writeFileSync(join(out, 'actual-liveDescriptions.json'), actual);
// Adapter contract: convert(input) -> {filename: serialized bytes}; control = original input -> production files.
const { adapters, production } = await import(pathToFileURL(resolve(adapterPath)).href);
const reports = [];
for (const adapter of adapters) {
  if (!/^[a-f0-9]{40}$/.test(adapter.sha))
    throw new Error('Pin each converter adapter to its source commit');
  const control = await adapter.convert(base),
    next = await adapter.convert(JSON.parse(actual));
  const files = Object.keys(production);
  if (files.length !== 7) throw new Error('Require seven legacy consumer control files');
  const controls = files.every((file) => control[file] === production[file]);
  const differences = Object.fromEntries(
    Object.keys(next).map((file) => [file, { changed: next[file] !== control[file] }]),
  );
  for (const [file, bytes] of Object.entries(next)) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) throw new Error('Unsafe converter filename');
    writeFileSync(join(out, `${adapter.sha}-${file}`), String(bytes));
  }
  reports.push({ sha: adapter.sha, controls, differences });
}
if (reports.length !== 2)
  throw new Error('Require deployed and held converter controls, per parity-1103');
writeFileSync(
  join(out, 'parity.json'),
  JSON.stringify(
    {
      commit,
      receipt,
      byteParity: actual === expected,
      reports,
      method:
        'parity-1103: frozen export+stamp+merge, 7-file converter controls; classify consumer differences against B1/B2/B3/R1 before acceptance',
    },
    null,
    2,
  ) + '\n',
);
if (actual !== expected || reports.some((r) => !r.controls)) process.exitCode = 1;
