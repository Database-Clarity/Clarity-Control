/**
 * One-time removal of the retired legendary frame texts that are still published (owner approval
 * 2026-11-25, "Yes, remove all 51 from the published files").
 *
 *   plan <mirror.git> <live branch> <migration-inputs.json> <new output directory>
 *   push <mirror.git> <output directory> <live branch> <reviewed DATA> <reviewed LIVE>
 *
 * `plan` works in a disposable clone and changes no ref outside it. `push` lands exactly the
 * reviewed pair with one plain atomic push and refuses if anything moved since the plan.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { batchSchema, scheduleRequestSchema } from '@clarity/core/schedule';
import {
  currentSavePath,
  currentSaveStageRecord,
  exportWithInactiveMoves,
  hasTooltipText,
  isMovedInactive,
  pushedSchema,
  resolveAlias,
} from '../../packages/core/src/index.js';
import {
  buildLegacy,
  bungieIdentical,
  compile,
  exportLanguages,
  legacyPresets,
  newStyleFile,
  type FormatV2File,
  type LegacyInput,
} from '../../packages/export/src/index.js';
import { newUlid } from '../../apps/worker/src/schedule/store.js';
import { maxBuffer } from '../publisher/childProcess.mjs';
import { appCredits, LocalRepository, type Tree } from '../publisher/git.js';
import { GlobalsPublisher } from '../publisher/globals.js';
import { liveGlobalsInput } from '../publisher/globalsInPlace.js';
import type { MigrationInputs } from '../publisher/globalsMigration.js';
import { paths, Publisher } from '../publisher/publisher.js';
import { translationRoots, translationRootsPath } from '../publisher/translations.js';

/** The census the owner approved. The plan rebuilds it from data and refuses any difference. */
export const approvedHashes = [
  31057037, 40492375, 183772609, 216781713, 263649945, 621911507, 715195141, 749936529, 757651572,
  806997698, 836583820, 878286503, 895140517, 918679156, 996573084, 1019291327, 1220310607,
  1236001742, 1294026524, 1322370662, 1395789926, 1525239159, 1636108362, 1713394949, 1739861752,
  1748364716, 1817649409, 1827389998, 2057203855, 2101490074, 2170254329, 2353477480, 2662827496,
  2732540911, 2757685314, 3030812579, 3114731754, 3252839262, 3330548924, 3364911712, 3419274965,
  3449390870, 3468089894, 3615521782, 3665558569, 3794558792, 3920852688, 3983457027, 4000302358,
  4074888076, 4172267910,
];
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Own LIVE rows with English whose editor tooltip has none, with every reason to keep a row. */
export function census(pub: Publisher, tree: Tree, perks: LegacyInput['perks']) {
  const aliases = pub.aliasesAt(tree);
  const moves = pub.movesAt(tree);
  const documents = new GlobalsPublisher(pub).documents(tree, 'tooltips');
  const pushed = pushedSchema.parse(pub.read(tree, 'live/pushed.json'));
  const items = pub.options.aliasFacts?.items ?? {};
  // Every number in a LIVE row, or in an authored text or association (also through its alias).
  const mentions = new Map<number, Set<string>>();
  const collect = (source: string, value: unknown) => {
    for (const [token] of JSON.stringify(value).matchAll(/\d+/g))
      for (const hash of new Set([Number(token), resolveAlias(Number(token), aliases)]))
        mentions.set(hash, (mentions.get(hash) ?? new Set()).add(source));
  };
  for (const [hash, row] of Object.entries(perks)) {
    if ('editor' in row) collect(`LIVE ${hash}`, [row.editor, row.associated]);
    else collect(`LIVE ${hash}`, row.aliasOf);
  }
  for (const { hash, text, associated } of Object.values(documents))
    collect(`tooltip ${hash}`, [text, associated]);

  return Object.entries(perks).flatMap(([key, row]) => {
    const hash = Number(key);
    if (hash <= 3 || !('editor' in row) || !row.editor.en?.main.trim()) return [];
    if (documents[hash]?.text.en?.text.trim()) return [];
    const canonical = resolveAlias(hash, aliases);
    const item = items[hash];
    const keep = [
      ...(!item || !/^weapon-frame(-enhanced)?$/.test(item.categoryId) || item.exotic
        ? ['not a legendary weapon frame']
        : []),
      ...([hash, canonical].some((id) => documents[id] && hasTooltipText(documents[id]))
        ? ['editor text']
        : []),
      ...(pushed[hash] ? ['publication marker'] : []),
      ...(isMovedInactive(hash, moves) ? ['inactive move'] : []),
      ...Object.keys(tree)
        .filter((path) => path.startsWith('schedule/') && path.endsWith(`/tooltips/${hash}.json`))
        .map((path) => `batch text ${path}`),
      ...[...(mentions.get(hash) ?? [])].map((source) => `named by ${source}`),
    ];
    return [{ hash, name: row.name ?? '', categoryId: item?.categoryId, canonical, keep }];
  });
}

/** The drain rules of the shared text migration (globalsMigration.ts assertDrained). */
function assertDrained(pub: Publisher, git: LocalRepository, tree: Tree, live: string) {
  const open = Object.keys(tree).filter((path) => {
    if (/^(publish\/requests|globals\/intents)\//.test(path)) return true;
    if (path.startsWith(currentSavePath) && path.endsWith('/request.json'))
      return ['uploading', 'queued'].includes(
        currentSaveStageRecord.parse(pub.read(tree, path)).status,
      );
    if (/^schedule\/requests\/[^/.]+\.json$/.test(path))
      return ['pending', 'needs_attention'].includes(
        scheduleRequestSchema.parse(pub.read(tree, path)).status,
      );
    if (!/^schedule\/batches\/[^/]+\/batch\.json$/.test(path)) return false;
    const batch = batchSchema.parse(pub.read(tree, path));
    return (
      ['preparing', 'scheduled', 'publishing'].includes(batch.status) ||
      (batch.status === 'needs_attention' && batch.preparation?.returnStatus === 'scheduled')
    );
  });
  const candidates = git
    .git(['for-each-ref', '--format=%(refname)', 'refs/heads/publish-candidate/'])
    .split('\n')
    .filter(Boolean);
  const unrecorded = Object.keys(git.tree(live)).filter((path) => {
    if (!path.startsWith('.publish/receipts/')) return false;
    const log = pub.read<{ result?: { status?: string } }>(
      tree,
      path.replace('.publish/receipts/', 'publish/log/'),
    );
    return log?.result?.status !== 'done' && log?.result?.status !== 'unchanged';
  });
  const blockers = [...open, ...candidates, ...unrecorded];
  if (blockers.length) throw new Error(`Drain the publisher first: ${blockers.join(', ')}`);
}

/** Each of the 34 outputs must equal the one before without the removed rows, in the same order. */
export function proveOutputs(
  before: LegacyInput,
  after: LegacyInput,
  { catalog, inventoryItems, sandboxPerks }: MigrationInputs,
  removed: readonly number[],
) {
  if (!Object.keys(inventoryItems).length || !catalog.categories.length)
    throw new Error('The output proof requires the pinned manifest and format-v2 catalog.');
  const gone = new Set(removed.map(String));
  const oldIdentical = bungieIdentical(before, inventoryItems, sandboxPerks);
  const identical = bungieIdentical(after, inventoryItems, sandboxPerks);
  if (
    !isDeepStrictEqual(
      oldIdentical.filter((hash) => !gone.has(hash)),
      identical,
    )
  )
    throw new Error('The removal changes other Bungie-identical rows.');
  const lost: Record<string, string[]> = {};
  const compare = (name: string, old: Record<string, unknown>, next: Record<string, unknown>) => {
    const kept = Object.fromEntries(Object.entries(old).filter(([hash]) => !gone.has(hash)));
    if (JSON.stringify(kept) !== JSON.stringify(next))
      throw new Error(`The removal changes other rows of ${name}.`);
    lost[name] = Object.keys(old).filter((hash) => gone.has(hash));
  };
  const parse = <T>(bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as T;
  for (const preset of legacyPresets)
    compare(
      preset,
      parse(buildLegacy(before, preset, { identical: oldIdentical })),
      parse(buildLegacy(after, preset, { identical })),
    );
  for (const style of ['structured', 'markdown'] as const)
    for (const lang of exportLanguages) {
      const name = `${style}/${lang}`;
      const file = newStyleFile('removal', style, {
        categories: catalog.categories.map(({ id }) => id),
        sandboxPerks: [],
        frameAliases: true,
        languages: [lang],
        keys: ['name'],
        languageFiles: 'combined',
        bungieIdentical: false,
      });
      // Format v2 numbers its shared descriptions, so compare each perk with its resolved text.
      const rows = (input: LegacyInput, same: string[]) => {
        const { descriptions, perks, ...header } = parse<FormatV2File>(
          compile(input, file, { catalog, identical: same }).bytes,
        );
        const resolved = Object.fromEntries(
          Object.entries(perks).map(([hash, { description, ...keys }]) => [
            hash,
            { ...keys, description: descriptions[description] },
          ]),
        );
        return { header, resolved };
      };
      const old = rows(before, oldIdentical);
      const next = rows(after, identical);
      if (!isDeepStrictEqual(old.header, next.header))
        throw new Error(`The removal changes the header of ${name}.`);
      compare(name, old.resolved, next.resolved);
    }
  return lost;
}

export function planRemoval(pub: Publisher, inputs: MigrationInputs, approved = approvedHashes) {
  if (pub.git.constructor !== LocalRepository)
    throw new Error('The removal is planned only in a disposable local clone.');
  const git = pub.git as LocalRepository;
  const { dataBranch, liveBranch, facts, generatorSha } = pub.options;
  const data = pub.head(dataBranch);
  const live = pub.head(liveBranch);
  const tree = git.tree(data);
  const liveTree = git.tree(live);
  assertDrained(pub, git, tree, live);

  const before = liveGlobalsInput(pub, live);
  if (git.blob(liveTree['liveDescriptions.json']) !== json(before))
    throw new Error('LIVE is not in the published format.');
  const candidates = census(pub, tree, before.perks);
  const excluded = candidates.filter(({ keep }) => keep.length);
  const removed = candidates.filter(({ keep }) => !keep.length).map(({ hash }) => hash);
  if (!isDeepStrictEqual(removed, approved))
    throw new Error(
      `The census differs from the approved rows: ${JSON.stringify({
        unapproved: removed.filter((hash) => !approved.includes(hash)),
        missing: approved.filter((hash) => !removed.includes(hash)),
        excluded,
      })}`,
    );

  // Today's exporter writes neither a row nor a stub for an empty tooltip and its grouped members,
  // and an ordinary publish merges into the LIVE rows without bringing one back.
  const exported = exportWithInactiveMoves(
    Object.values(new GlobalsPublisher(pub).documents(tree, 'tooltips')),
    0,
    facts,
    pub.aliasesAt(tree),
    pub.movesAt(tree),
  );
  const perks = { ...before.perks };
  for (const hash of removed) delete perks[hash];
  const merged = pub.mergePublicationPerks(tree, perks, {}, []);
  const back = removed.filter((hash) => exported[hash] || merged[hash]);
  if (back.length) throw new Error(`The exporter still writes ${back.join(', ')}.`);
  const after = { ...before, perks };
  const lost = proveOutputs(before, after, inputs, removed);

  const title = `Remove ${removed.length} retired legendary frame texts (owner approved)`;
  const nextLive = git.commit(
    live,
    { ...liveTree, 'liveDescriptions.json': git.writeBlob(json(after)) },
    `${title}\n\nThe editor has no text for these legendary weapon frames. Every other\nrow keeps its bytes.\n`,
    appCredits,
  );
  const now = pub.options.now();
  const record: Tree = {
    ...tree,
    [paths(newUlid(now)).log]: git.writeBlob(
      json({
        request: null,
        intentDigest: null,
        candidateCommit: nextLive,
        result: {
          status: 'done',
          message: title,
          outcomes: removed.map((hash) => ({ hash, digest: null, status: 'removed' })),
        },
        liveCommit: nextLive,
        recordCommit: null,
        pins: { publisherSha: null, generatorSha },
        runUrl: null,
        times: { now },
      }),
    ),
  };
  // Unmarked rows are never active translation sources: only the index's LIVE commit moves.
  if (tree[translationRootsPath]) {
    const next = translationRoots(pub, tree, nextLive, after, { data: tree, liveCommit: live });
    const index = pub.read<typeof next>(tree, translationRootsPath);
    if (!isDeepStrictEqual(index, { ...next, liveCommit: live }))
      throw new Error('The translation source index is not current. Run the pipeline first.');
    record[translationRootsPath] = git.writeBlob(json(next));
  }
  const nextData = git.commit(
    data,
    record,
    `${title}\n\nRecord the removal from ${liveBranch}. Authored files, markers, and\nstored source snapshots stay as they are.\n`,
    appCredits,
  );
  git.casMany([
    { ref: `refs/heads/${dataBranch}`, old: data, next: nextData },
    { ref: `refs/heads/${liveBranch}`, old: live, next: nextLive },
  ]);
  return {
    liveBranch,
    data: { before: data, after: nextData },
    live: { before: live, after: nextLive },
    removed: candidates.filter(({ keep }) => !keep.length),
    excluded,
    lost,
  };
}

const gitRun = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer, stdio: 'pipe' });

function plan(mirror: string, liveBranch: string, inputs: string, output: string) {
  mkdirSync(output);
  const temp = mkdtempSync(join(tmpdir(), 'retired-frames-'));
  try {
    const repo = join(temp, 'simulator.git');
    gitRun('clone', '--quiet', '--mirror', '--no-hardlinks', '--', resolve(mirror), repo);
    gitRun('--git-dir', repo, 'remote', 'remove', 'origin');
    gitRun('--git-dir', repo, 'config', 'publisher.simulator', 'true');
    const git = new LocalRepository(repo);
    const tree = git.tree(git.head('refs/heads/editor-data')!);
    const config = JSON.parse(git.blob(tree['.publisher/config.json']));
    const result = planRemoval(
      new Publisher(git, { ...config, liveBranch, now: Date.now }),
      JSON.parse(readFileSync(inputs, 'utf8')) as MigrationInputs,
    );
    gitRun(
      ...['--git-dir', repo, 'bundle', 'create', join(resolve(output), 'would-be-commits.bundle')],
      ...['refs/heads/editor-data', `refs/heads/${liveBranch}`],
      ...[`^${result.data.before}`, `^${result.live.before}`],
    );
    writeFileSync(join(output, 'result.json'), json(result));
    console.log(json(result));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function push(mirror: string, output: string, liveBranch: string, data: string, live: string) {
  const planned = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')) as ReturnType<
    typeof planRemoval
  >;
  if (
    planned.liveBranch !== liveBranch ||
    planned.data.after !== data ||
    planned.live.after !== live
  )
    throw new Error('The reviewed commits differ from the plan.');
  const repo = 'Database-Clarity/Live-Clarity-Database';
  const dataRef = 'refs/heads/editor-data';
  const liveRef = `refs/heads/${liveBranch}`;
  const bundleRef = 'refs/heads/editor-data-bundle';
  const git = (...args: string[]) => gitRun('--git-dir', resolve(mirror), ...args);
  const remote = git('remote', 'get-url', 'origin').trim();
  const heads = () =>
    Object.fromEntries(
      git('ls-remote', remote, 'refs/heads/publish-candidate/*', dataRef, liveRef, bundleRef)
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t').reverse()),
    ) as Record<string, string>;
  git('fetch', '--quiet', join(resolve(output), 'would-be-commits.bundle'), dataRef, liveRef);
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = execFileSync(
      'gh',
      ['run', 'list', '--repo', repo, '--branch', 'editor-data', '--status', status, '--json=url'],
      { encoding: 'utf8' },
    );
    if (JSON.parse(runs).length) throw new Error(`Workflows are ${status}: ${runs}`);
  }
  const { [bundleRef]: bundle, ...current } = heads();
  if (
    !isDeepStrictEqual(current, { [dataRef]: planned.data.before, [liveRef]: planned.live.before })
  )
    throw new Error(`A head moved or a candidate appeared. Plan again: ${json(current)}`);
  git('fetch', '--quiet', '--no-tags', remote, bundle);
  if (JSON.parse(git('show', `${bundle}:bundle.json`)).sourceCommit !== planned.data.before)
    throw new Error('The editor bundle is not current. Let the pipeline finish first.');
  git('push', '--atomic', remote, `${data}:${dataRef}`, `${live}:${liveRef}`);
  const landed = heads();
  if (landed[dataRef] !== data || landed[liveRef] !== live)
    throw new Error(`Read both refs and check for an intervening write: ${json(landed)}`);
  console.log(json(landed));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan' && args.length === 4) plan(args[0], args[1], args[2], args[3]);
  else if (command === 'push' && args.length === 5)
    push(args[0], args[1], args[2], args[3], args[4]);
  else throw new Error('Usage: read the header of retired-frames.ts');
}
