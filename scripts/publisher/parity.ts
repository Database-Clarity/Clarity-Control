/** Read-only parity at frozen receipt inputs; converter adapters must be independently pinned. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  exportWithInactiveMoves,
  applyInactiveLive,
  inactiveMovesPath,
  inactiveMovesSchema,
  inactivePublishableHash,
  selectedInactiveMoves,
  mergeLivePerks,
  aliasGroupsPath,
  aliasGroupsSchema,
  sandboxPointersPath,
  sandboxPointersSchema,
  globalsInPlaceFenceSchema,
  globalsInPlacePath,
  permissionsSchema,
  stableStringify,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { maxBuffer } from './childProcess.mjs';
import { Publisher, type Options } from './publisher.js';
import {
  assertInPlaceDocuments,
  exportGlobalsProof,
  planInPlaceRelease,
  proveInPlaceInputs,
} from './globalsInPlace.js';
import type { Repository, Tree } from './git.js';
import type { LegacyInput } from '../../packages/export/src/index.js';
const [repo, commit, receiptPath, configPath, adapterPath, outArg] = process.argv.slice(2);
if (!outArg)
  throw new Error(
    'Usage: parity.mjs repo liveCommit receiptPath config.json converter-adapters.mjs outputDir',
  );
const git = (...args: string[]) =>
  execFileSync('git', ['-C', resolve(repo), ...args], {
    encoding: 'utf8',
    maxBuffer,
  });
const read = (ref: string, path: string) => JSON.parse(git('show', `${ref}:${path}`));
const receipt = read(commit, receiptPath);
if (!/^[a-f0-9]{40}$/.test(commit) || !receiptPath.startsWith('.publish/receipts/'))
  throw new Error('Exact test live commit and receipt required');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Pick<
  Options,
  'facts' | 'aliases' | 'sandboxConflicts' | 'generatorSha' | 'aliasFacts'
>;
if (config.generatorSha !== receipt.generatorSha)
  throw new Error('Generator pin differs from receipt');
const base = read(receipt.liveParent, 'liveDescriptions.json');
const actual = git('show', `${commit}:liveDescriptions.json`);
const tooltips: Tooltip[] = receipt.entries.map((e: { tooltipBlob: string }) =>
  JSON.parse(git('cat-file', 'blob', e.tooltipBlob)),
);
// Both configs come from S, with the publisher's real pinned-fact checks and composition.
const atSource = (path: string): unknown =>
  git('ls-tree', '--name-only', receipt.sourceCommit, '--', path).trim()
    ? read(receipt.sourceCommit, path)
    : undefined;
const picks = atSource(sandboxPointersPath);
const groups = atSource(aliasGroupsPath);
const aliases = Publisher.aliasesAt(config, groups, picks);
const moves = git('ls-tree', '--name-only', receipt.sourceCommit, '--', inactiveMovesPath).trim()
  ? inactiveMovesSchema.parse(read(receipt.sourceCommit, inactiveMovesPath))
  : {};
// Digests include incoming aliases: verify with the same merged aliases the publisher used.
for (let i = 0; i < tooltips.length; i++)
  if ((await inactivePublishableHash(tooltips[i], aliases, moves)) !== receipt.entries[i].digest)
    throw new Error('Receipt digest mismatch');
const hashes = tooltips.map((tooltip) => tooltip.hash);
const request = read(receipt.sourceCommit, `publish/requests/${receipt.opId}.json`);
const payload = JSON.parse(request.payload);
const fence = globalsInPlaceFenceSchema.optional().parse(atSource(globalsInPlacePath));
if (Boolean(receipt.inPlace) !== Boolean(fence) || (fence && fence.state !== 'active'))
  throw new Error('Receipt belongs to a different shared-text mode');
const sourceTree = (): Tree =>
  Object.fromEntries(
    git('ls-tree', '-rz', receipt.sourceCommit)
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]];
      }),
  );
const plan =
  fence &&
  (() => {
    const tree = sourceTree();
    const readOnly = {
      blob: (oid: string) => git('cat-file', 'blob', oid),
    } as Repository;
    const publisher = new Publisher(readOnly, {
      ...config,
      liveBranch: fence.destination,
    } as Options);
    const selections = payload.kind === 'push' ? (payload.globals ?? []) : [];
    const role = permissionsSchema.parse(atSource('config/permissions.json')).users[
      payload.requester.id
    ]?.role;
    const release = planInPlaceRelease(
      publisher,
      tree,
      base,
      selections,
      role === 'maintainer',
      hashes.length > 0,
    );
    if (
      stableStringify(release.globals) !== stableStringify(receipt.inPlace.globals) ||
      stableStringify(release.refusals) !== stableStringify(receipt.inPlace.refusals ?? [])
    )
      throw new Error('Receipt shared definitions differ from the request');
    return release;
  })();
const globalsInPlace = plan?.options;
const live = plan ? ({ ...base, perks: { ...base.perks, ...plan.refills } } as LegacyInput) : base;
if (globalsInPlace) assertInPlaceDocuments(tooltips, globalsInPlace);
const selectedMoves = selectedInactiveMoves(moves, hashes, aliases);
const exported = exportWithInactiveMoves(
  tooltips,
  receipt.now,
  config.facts,
  aliases,
  selectedMoves,
  globalsInPlace && { globalsInPlace },
);
const requester = payload.requester;
stampUploads(exported, new Set<number>(receipt.changed), base.perks, receipt.now, requester.login);
const merge = (entries: typeof exported): LegacyInput =>
  receipt.inPlace && !hashes.length
    ? live
    : {
        ...base,
        perks: applyInactiveLive(
          mergeLivePerks(
            live.perks,
            entries,
            picks === undefined
              ? undefined
              : {
                  keys: Object.keys(sandboxPointersSchema.parse(picks).pointers),
                  aliases,
                  catalog: config.facts,
                },
            groups === undefined ? undefined : { aliases, catalog: config.facts },
            groups === undefined ? undefined : aliasGroupsSchema.parse(groups).removed,
          ),
          moves,
          hashes,
          aliases,
          live.perks,
        ),
      };
const merged = merge(exported);
if (globalsInPlace && hashes.length) {
  const { raw, fallbacks } = exportGlobalsProof(
    tooltips,
    receipt.now,
    config.facts,
    aliases,
    selectedMoves,
    globalsInPlace,
  );
  proveInPlaceInputs(base, merge(raw), merged, globalsInPlace, hashes, fallbacks);
}
const expected = JSON.stringify(merged, null, 2) + '\n';
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
