import { stableStringify } from '../contentHash.js';
import { resolveAlias } from '../aliases.js';
import { calculateGlobalImpact } from '../globals/impact.js';
import { projectGlobals } from '../globals/projection.js';
import { globalReferenceSpans } from '../globals/references.js';
import { globalSourceText } from '../globals/source.js';
import type {
  GlobalImpactChange,
  GlobalImpactRow,
  GlobalImpactSnapshot,
  GlobalImpact,
} from '../globals/impactModel.js';
import type { GlobalCause, GlobalStore } from '../globals/model.js';
import type { Tooltip } from '../schemas.js';
import { changedGlobalIds, composeGlobalRelease } from './compose.js';
import { globalIdentityDigest } from './model.js';

export interface GlobalReleaseInput {
  saved: GlobalStore;
  published: GlobalStore;
  authored: GlobalImpactSnapshot;
  live: GlobalImpactSnapshot;
  /** All queued and previously materialized causes for outstanding revisions. */
  causes: GlobalCause[];
  destination: string;
  priorAuthored?: {
    snapshot: GlobalImpactSnapshot;
    names: Record<string, string>;
    /** Actual published inputs at this historical cause, validated independently. */
    published: GlobalImpactSnapshot;
  }[];
}
export interface GlobalReleaseRow {
  id: string;
  view: GlobalImpactRow;
  contentDigest: string;
  dependencyDigest: string;
  impactDigest: string;
  beforeSource: string;
  afterSource: string;
}
export interface GlobalReleaseComponent {
  ids: string[];
  rows: GlobalReleaseRow[];
  /** Every currently live affected consumer plus every library required by its imports. */
  hashes: number[];
  store: GlobalStore;
}

function changes(
  input: GlobalReleaseInput,
  ids: string[],
  names?: Record<string, string>,
): GlobalImpactChange[] {
  return ids.flatMap((id) => {
    const old = input.published.entries.find((entry) => entry.id === id);
    const next = input.saved.entries.find((entry) => entry.id === id)!;
    const causes = input.causes.filter((cause) => cause.globalId === id);
    if (!causes.length)
      causes.push({
        globalId: id,
        beforeRevision: old?.revision ?? null,
        afterRevision: next.revision,
      });
    return causes.map((cause) => ({
      cause,
      kind: next.kind,
      beforeName: names?.[id] ?? old?.name,
      afterName: next.name,
    }));
  });
}

function impacts(input: GlobalReleaseInput, store: GlobalStore, ids: string[]) {
  const beforeGlobals = projectGlobals(input.published),
    afterGlobals = projectGlobals(store);
  const afterLive = Object.fromEntries(
    Object.entries({ ...input.live.tooltips, ...input.authored.tooltips, ...afterGlobals }).filter(
      ([, document]) => resolveAlias(document.hash, input.authored.aliases) === document.hash,
    ),
  );
  // Missing saved rows retain the published source. They are not silently deleted.
  const pairs = [
    [
      { ...input.authored, tooltips: { ...input.authored.tooltips, ...beforeGlobals } },
      { ...input.authored, tooltips: { ...input.authored.tooltips, ...afterGlobals } },
      undefined,
      undefined,
    ],
    ...(input.priorAuthored ?? []).map(
      ({ snapshot, names, published }) =>
        [
          snapshot,
          { ...input.authored, tooltips: { ...input.authored.tooltips, ...afterGlobals } },
          names,
          published,
        ] as const,
    ),
    [
      { ...input.live, tooltips: { ...input.live.tooltips, ...beforeGlobals } },
      {
        ...input.live,
        aliases: input.authored.aliases,
        types: input.authored.types,
        tooltips: afterLive,
      },
      undefined,
      undefined,
    ],
  ] as const;
  return pairs.map(([before, after, names, published]) => {
    if (published && !calculateGlobalImpact(published, published, [], input.destination).complete)
      throw new Error('Sync pending: historical published closure is incomplete');
    let observedBefore = before;
    let result = calculateGlobalImpact(
      observedBefore,
      after,
      changes(input, ids, names),
      input.destination,
    );
    if (!result.complete && names && published) {
      // A failed, never-published intermediate definition has no valid render.
      // Keep its authored consumers and causes, and review them against the real
      // published baseline. Current/after inputs must still resolve completely.
      observedBefore = {
        ...before,
        tooltips: { ...before.tooltips, 2: published.tooltips[2], 3: published.tooltips[3] },
      };
      result = calculateGlobalImpact(
        observedBefore,
        after,
        changes(input, ids, names),
        input.destination,
      );
    }
    if (!result.complete) throw new Error('Sync pending: resolver closure is incomplete');
    return expandReleaseDependencies(
      input,
      observedBefore,
      after,
      result,
      changes(input, ids, names).map((change) => change.cause),
    );
  });
}

/** Publishing a changed import source can also alter readers of its OTHER exports.
 * Use a full S1 read census to close that set; never reconstruct resolver execution.
 */
function expandReleaseDependencies(
  input: GlobalReleaseInput,
  before: GlobalImpactSnapshot,
  after: GlobalImpactSnapshot,
  impact: GlobalImpact,
  causes: GlobalCause[],
): GlobalImpact {
  const probe = [
    { kind: 'titles' as const, beforeName: 'Release', afterName: 'Release', cause: causes[0] },
  ];
  const census = calculateGlobalImpact(before, after, probe, input.destination);
  if (!census.complete) throw new Error('Sync pending: import release closure is incomplete');
  const key = (row: GlobalImpactRow) => `${row.consumer.hash}:${row.consumer.lang}`;
  const rows = new Map(impact.rows.map((row) => [key(row), row]));
  // Aggregate timestamp fallback can change a second variable even when its own
  // definition did not change. Compare real renders while holding consumers fixed.
  const globalOnly = calculateGlobalImpact(
    before,
    { ...before, tooltips: { ...before.tooltips, 2: after.tooltips[2], 3: after.tooltips[3] } },
    probe,
    input.destination,
  );
  if (!globalOnly.complete) throw new Error('Sync pending: global fallback closure is incomplete');
  for (const row of globalOnly.rows)
    if (row.before?.rendered !== row.after?.rendered && !rows.has(key(row))) {
      const actual = census.rows.find((candidate) => key(candidate) === key(row));
      if (actual)
        rows.set(key(actual), {
          ...actual,
          reason: 'variable-read',
          causes: [...new Map(causes.map((cause) => [stableStringify(cause), cause])).values()],
        });
    }
  const dependencies = new Map<number, Map<string, GlobalCause>>();
  let progress = true;
  while (progress) {
    progress = false;
    const add = (hash: number, causes: GlobalCause[]) => {
      hash = resolveAlias(hash, after.aliases);
      // Libraries 2/3 are composed separately; S1 already tracks aggregate imports.
      if (
        hash === 2 ||
        hash === 3 ||
        stableStringify(input.live.tooltips[hash] ?? null) ===
          stableStringify(after.tooltips[hash] ?? null)
      )
        return;
      const existing = dependencies.get(hash) ?? new Map<string, GlobalCause>();
      for (const cause of causes)
        if (!existing.has(stableStringify(cause))) {
          existing.set(stableStringify(cause), cause);
          progress = true;
        }
      dependencies.set(hash, existing);
    };
    for (const row of rows.values()) {
      if (input.live.tooltips[row.consumer.hash] || input.live.aliases[row.consumer.hash])
        add(row.consumer.hash, row.causes);
      for (const read of [
        ...(row.before?.reads.imports ?? []),
        ...(row.after?.reads.imports ?? []),
      ])
        add(read.hash, row.causes);
    }
    for (const row of census.rows) {
      const causes = new Map(
        (rows.get(key(row))?.causes ?? []).map((cause) => [stableStringify(cause), cause]),
      );
      const reads = [
        row.consumer.hash,
        ...[...(row.before?.reads.imports ?? []), ...(row.after?.reads.imports ?? [])].map(
          (read) => read.hash,
        ),
      ];
      for (const hash of reads)
        for (const [id, cause] of dependencies.get(hash) ?? [])
          if (!causes.has(id)) {
            causes.set(id, cause);
            progress = true;
          }
      if (causes.size)
        rows.set(key(row), {
          ...row,
          reason: rows.get(key(row))?.reason ?? 'aggregate-import',
          causes: [...causes.values()],
        });
    }
  }
  return { ...impact, rows: [...rows.values()] };
}

/** Pure offline planning through S1's real resolver. Connected causes release together;
 * separate components are composed independently over last-published definitions.
 */
export async function planGlobalRelease(
  input: GlobalReleaseInput,
): Promise<GlobalReleaseComponent[]> {
  const changed = changedGlobalIds(input.published, input.saved);
  if (!changed.length) return [];
  const groups = changed.map((id) => new Set([id]));
  const join = (ids: readonly string[]) => {
    const touching = groups.filter((group) => ids.some((id) => group.has(id)));
    if (touching.length < 2) return;
    const target = touching[0];
    for (const group of touching.slice(1)) {
      for (const id of group) target.add(id);
      groups.splice(groups.indexOf(group), 1);
    }
  };
  const complete = impacts(input, input.saved, changed);
  for (const result of complete)
    for (const row of result.rows) join(row.causes.map((cause) => cause.globalId));
  const membership = new Map<string, Set<string>>();
  // Single-entry candidates expose fallback/dependency interactions hidden by a
  // simultaneous edit. Consumers shared by them form one coherent release group.
  for (const id of changed)
    for (const impact of impacts(input, composeGlobalRelease(input.published, input.saved, [id]), [
      id,
    ]))
      for (const row of impact.rows) {
        const key = `${row.consumer.hash}:${row.consumer.lang}`;
        const ids = membership.get(key) ?? new Set<string>();
        ids.add(id);
        membership.set(key, ids);
        join([...ids]);
      }
  // Declaration-to-declaration edges conservatively connect even currently unused globals.
  // This is discovery only: the actual candidate is still checked by the resolver below.
  for (const store of [input.saved, input.published])
    for (const entry of store.entries) {
      const reads = Object.values(entry.definitions).flatMap((cell) =>
        (['variables', 'titles'] as const).flatMap((kind) =>
          globalReferenceSpans(cell.body, kind).map((span) => ({ kind, name: span.name })),
        ),
      );
      join([
        entry.id,
        ...store.entries
          .filter((other) =>
            reads.some((read) => read.kind === other.kind && read.name === other.name),
          )
          .map((other) => other.id),
      ]);
    }
  const result: GlobalReleaseComponent[] = [];
  for (const group of groups) {
    const ids = [...group].sort();
    const store = composeGlobalRelease(input.published, input.saved, ids);
    const contexts = impacts(input, store, ids);
    const rows = new Map<string, GlobalReleaseRow>();
    for (const impact of contexts)
      for (const view of impact.rows) {
        const { hash, lang } = view.consumer;
        const saved = input.authored.tooltips[hash] ?? input.live.tooltips[hash];
        if (!saved) throw new Error('Deleted consumer dependency');
        const dependencies = new Set(
          [...(view.before?.reads.imports ?? []), ...(view.after?.reads.imports ?? [])].map(
            (read) => resolveAlias(read.hash, input.authored.aliases),
          ),
        );
        const dependencyDocuments: Record<string, Tooltip> = {};
        for (const dependency of dependencies) {
          const document =
            dependency === 2 || dependency === 3
              ? projectGlobals(store)[dependency]
              : (input.authored.tooltips[dependency] ?? input.live.tooltips[dependency]);
          if (!document) throw new Error('Deleted imported dependency');
          dependencyDocuments[dependency] = document;
        }
        const id = await globalIdentityDigest(view.consumer);
        // Both authored and actual prospective live contexts bind the one displayed review.
        const old = rows.get(id);
        const previous =
          input.live.tooltips[hash] ??
          input.priorAuthored?.find(({ snapshot }) => snapshot.tooltips[hash])?.snapshot.tooltips[
            hash
          ] ??
          input.authored.tooltips[hash];
        const beforeSource = previous
          ? (globalSourceText(previous, lang, input.live.tooltips[hash] ? 'live' : 'authored') ??
            '')
          : '';
        const afterSource = globalSourceText(saved, lang, 'live') ?? '';
        rows.set(id, {
          id,
          view: {
            ...view,
            before: view.before ?? old?.view.before ?? null,
            causes: [
              ...new Map(
                [...(old?.view.causes ?? []), ...view.causes].map((cause) => [
                  stableStringify(cause),
                  cause,
                ]),
              ).values(),
            ],
          },
          beforeSource,
          afterSource,
          contentDigest: await globalIdentityDigest(saved),
          dependencyDigest: await globalIdentityDigest({
            ids,
            entries: store.entries.filter((entry) => ids.includes(entry.id)),
            dependencyDocuments,
            aliases: input.authored.aliases,
            types: input.authored.types,
            reads: [view.before?.reads, view.after?.reads],
          }),
          impactDigest: await globalIdentityDigest([
            old?.impactDigest ?? null,
            view,
            beforeSource,
            afterSource,
          ]),
        });
      }
    const hashes = new Set<number>();
    for (const row of rows.values()) {
      if (input.live.tooltips[row.view.consumer.hash] || input.live.aliases[row.view.consumer.hash])
        hashes.add(resolveAlias(row.view.consumer.hash, input.authored.aliases));
      for (const read of [
        ...(row.view.before?.reads.imports ?? []),
        ...(row.view.after?.reads.imports ?? []),
      ])
        hashes.add(resolveAlias(read.hash, input.authored.aliases));
    }
    // Both reserved libraries are emitted from the candidate, never from saved aggregates.
    hashes.add(2);
    hashes.add(3);
    result.push({
      ids,
      rows: [...rows.values()],
      hashes: [...hashes].sort((a, b) => a - b),
      store,
    });
  }
  // Determinism makes retries, acknowledgement comparison, and crash recovery straightforward.
  return result.sort((a, b) => stableStringify(a.ids).localeCompare(stableStringify(b.ids)));
}
