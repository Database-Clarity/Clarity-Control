/** Read-only parity at frozen receipt inputs; converter adapters must be independently pinned. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activeAliases,
  exportWithInactiveMoves,
  applyInactiveLive,
  inactiveMovesPath,
  inactiveMovesSchema,
  inactivePublishableHash,
  isMovedInactive,
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
import { Publisher, paths, type Options, type Receipt } from './publisher.js';
import { GlobalsPublisher } from './globals.js';
import { assertTranslationTree, translationRoots, translationRootsPath } from './translations.js';
import {
  assertInPlaceDocuments,
  assertScheduledGlobalNames,
  authoredInPlaceOptions,
  exportGlobalsProof,
  neutralRenameHashes,
  planInPlaceRelease,
  proveInPlaceInputs,
  refillImportedTooltips,
} from './globalsInPlace.js';
import type { Repository, Tree } from './git.js';
import type { LegacyInput } from '../../packages/export/src/index.js';
const [repo, commit, receiptPath, configPath, adapterPath, outArg, recordCommit] =
  process.argv.slice(2);
if (!outArg)
  throw new Error(
    'Usage: parity.mjs repo liveCommit receiptPath config.json converter-adapters.mjs outputDir [scopedRecordCommit]',
  );
const git = (...args: string[]) =>
  execFileSync('git', ['-C', resolve(repo), ...args], {
    encoding: 'utf8',
    maxBuffer,
  });
const read = (ref: string, path: string) => JSON.parse(git('show', `${ref}:${path}`));
const receipt: Receipt = read(commit, receiptPath);
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
const sourceTree = (source = receipt.sourceCommit): Tree =>
  Object.fromEntries(
    git('ls-tree', '-rz', source)
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]];
      }),
  );
const staged = new Map<string, string>();
const readOnly = {
  blob: (oid: string) => staged.get(oid) ?? git('cat-file', 'blob', oid),
  writeBlob: (bytes: string) => {
    const oid = execFileSync('git', ['-C', resolve(repo), 'hash-object', '--stdin'], {
      input: bytes,
      encoding: 'utf8',
    }).trim();
    staged.set(oid, bytes);
    return oid;
  },
  tree: sourceTree,
  treeModes: (source: string) =>
    Object.fromEntries(
      git('ls-tree', '-rtz', source)
        .split('\0')
        .filter(Boolean)
        .flatMap((line) => {
          const tab = line.indexOf('\t');
          const [mode, type, oid] = line.slice(0, tab).split(' ');
          return type === 'tree' && oid !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
            ? []
            : [[line.slice(tab + 1), mode]];
        }),
    ),
} as Repository;
async function scopedParity() {
  if (receiptPath !== paths(receipt.opId).receipt)
    throw new Error('Receipt path differs from scoped opId');
  if (!recordCommit || !/^[a-f0-9]{40}$/.test(recordCommit))
    throw new Error('Exact DATA RECORD commit required for scoped parity');
  const frozen = read(receipt.sourceCommit, '.publisher/config.json') as Options;
  const pin = read(receipt.sourceCommit, '.publisher/PIN') as { sha256: string };
  const recordParent = git('rev-parse', `${recordCommit}^`).trim();
  const repository = {
    ...readOnly,
    ancestor: (older: string, newer: string) => {
      try {
        git('merge-base', '--is-ancestor', older, newer);
        return true;
      } catch {
        return false;
      }
    },
    head: (ref: string) =>
      ref === `refs/heads/${frozen.liveBranch}`
        ? commit
        : ref === `refs/heads/${frozen.dataBranch}`
          ? recordParent
          : undefined,
  };
  const publisher = new Publisher(repository, {
    ...frozen,
    ...config,
    publisherDigest: pin.sha256,
  });
  const verified = await publisher.verifyTranslationReceipt(receipt, commit);
  const parent = sourceTree(recordParent);
  const after = sourceTree(recordCommit);
  const expected = { ...parent, ...verified.data };
  const allowed = new Map<string, string | null>(Object.entries(verified.data));
  const { request, log } = paths(receipt.opId);
  const record = read(recordCommit, log);
  if (
    record.candidateCommit !== commit ||
    record.liveCommit !== commit ||
    record.intentDigest !== receipt.intentDigest ||
    record.result.status !== (receipt.outcome === 'published' ? 'done' : 'unchanged') ||
    stableStringify(record.result.rows) !== stableStringify(receipt.translations!.rows) ||
    stableStringify(record.request) !==
      stableStringify(JSON.parse(readOnly.blob(receipt.requestBlob)))
  )
    throw new Error('DATA RECORD does not match scoped receipt');
  await new GlobalsPublisher(publisher).recordProofs(expected, recordParent, commit);
  for (const path of new Set([...Object.keys(parent), ...Object.keys(expected)])) {
    if (path.startsWith('globals/proofs/') && parent[path] !== expected[path])
      allowed.set(path, expected[path] ?? null);
  }
  allowed.set(
    translationRootsPath,
    readOnly.writeBlob(
      JSON.stringify(translationRoots(publisher, expected, commit, verified.input), null, 2) + '\n',
    ),
  );
  allowed.set(request, null);
  allowed.set(log, after[log]);
  assertTranslationTree(parent, after, allowed);
  return verified.bytes;
}
async function ordinaryParity() {
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
  const plan =
    fence &&
    (() => {
      const tree = sourceTree();
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
        stableStringify(release.globals) !== stableStringify(receipt.inPlace!.globals) ||
        stableStringify(release.refusals) !== stableStringify(receipt.inPlace!.refusals ?? [])
      )
        throw new Error('Receipt shared definitions differ from the request');
      const neutral = neutralRenameHashes(publisher, tree, receipt.entries, release.rewritten);
      const documents = tooltips.filter(({ hash }) => !neutral.has(hash));
      const selectedMoves = selectedInactiveMoves(
        moves,
        documents.map(({ hash }) => hash),
        aliases,
      );
      const active = documents.filter(({ hash }) => !isMovedInactive(hash, selectedMoves));
      if (payload.kind === 'batch') assertScheduledGlobalNames(active, release);
      const options = authoredInPlaceOptions(
        publisher,
        tree,
        base,
        release,
        active,
        activeAliases(aliases, selectedMoves),
      );
      const live = {
        ...base,
        perks: { ...base.perks, ...release.refills } as LegacyInput['perks'],
      };
      return { ...release, options, documents, active, selectedMoves, live, publisher, tree };
    })();
  const globalsInPlace = plan?.options;
  const publishable = plan?.documents ?? tooltips;
  const selectedMoves = plan?.selectedMoves ?? selectedInactiveMoves(moves, hashes, aliases);
  if (plan) assertInPlaceDocuments(plan.active, plan.options);
  const exported = exportWithInactiveMoves(
    publishable,
    receipt.now,
    config.facts,
    aliases,
    selectedMoves,
    globalsInPlace && { globalsInPlace },
  );
  if (plan)
    refillImportedTooltips(
      plan.publisher,
      plan.tree,
      plan,
      plan.active,
      activeAliases(aliases, selectedMoves),
      exported,
    );
  const live = plan?.live ?? base;
  const requester = payload.requester;
  stampUploads(
    exported,
    new Set<number>(receipt.changed),
    base.perks,
    receipt.now,
    requester.login,
  );
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
  if (globalsInPlace && publishable.length) {
    const raw = exportGlobalsProof(
      publishable,
      receipt.now,
      config.facts,
      aliases,
      selectedMoves,
      globalsInPlace,
    );
    proveInPlaceInputs(
      base,
      merge(raw),
      merged,
      globalsInPlace,
      publishable.map(({ hash }) => hash),
    );
  }
  return JSON.stringify(merged, null, 2) + '\n';
}
const expected = receipt.translations ? await scopedParity() : await ordinaryParity();
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
