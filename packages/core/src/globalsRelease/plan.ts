import { stableStringify } from '../contentHash.js';
import { resolveAlias } from '../aliases.js';
import { calculateGlobalImpact, GlobalSnapshotScans } from '../globals/impact.js';
import { projectGlobals } from '../globals/projection.js';
import { globalReferenceSpans } from '../globals/references.js';
import { globalSourceText } from '../globals/source.js';
import type { Lang } from '../languages.js';
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

/** Alias identity selects the render context; its authored text always lives on the canonical. */
function consumerDocument(snapshot: GlobalImpactSnapshot, hash: number): Tooltip | undefined {
  return snapshot.tooltips[resolveAlias(hash, snapshot.aliases)];
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

function impacts(
  input: GlobalReleaseInput,
  store: GlobalStore,
  ids: string[],
  scans: GlobalSnapshotScans,
  withdrawals?: ReadonlyMap<string, readonly Lang[] | null>,
) {
  const beforeGlobals = projectGlobals(input.published),
    afterGlobals = projectGlobals(store);
  const alternativeGlobals = new Map<string, Record<number, Tooltip> | undefined>();
  const fallbackAlternatives = (before: GlobalImpactSnapshot) => {
    return new Map(
      ids.map((id) => {
        if (!alternativeGlobals.has(id)) {
          try {
            alternativeGlobals.set(
              id,
              projectGlobals(
                composeGlobalRelease(
                  input.published,
                  input.saved,
                  ids.filter((candidate) => candidate !== id),
                ),
              ),
            );
          } catch {
            // Keep the cause when omitting this edit would make the store invalid.
            alternativeGlobals.set(id, undefined);
          }
        }
        const globals = alternativeGlobals.get(id);
        return [
          id,
          globals &&
            scans.resolve({
              ...before,
              tooltips: { ...before.tooltips, ...globals },
            }),
        ] as const;
      }),
    );
  };
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
    if (
      published &&
      !calculateGlobalImpact(published, published, [], input.destination, scans).complete
    )
      throw new Error('Sync pending: historical published closure is incomplete');
    let observedBefore = before;
    let result = calculateGlobalImpact(
      observedBefore,
      after,
      changes(input, ids, names),
      input.destination,
      scans,
    );
    if (!result.complete && names && published) {
      // A failed, never-published intermediate definition has no valid render.
      // Keep its authored consumers and causes, and review them against the real
      // published baseline. Current/after inputs must still resolve completely.
      observedBefore = {
        ...before,
        tooltips: {
          ...before.tooltips,
          ...Object.fromEntries(
            store.aggregates.map(({ document }) => [
              document.hash,
              published.tooltips[document.hash],
            ]),
          ),
        },
      };
      result = calculateGlobalImpact(
        observedBefore,
        after,
        changes(input, ids, names),
        input.destination,
        scans,
      );
    }
    if (!result.complete) throw new Error('Sync pending: resolver closure is incomplete');
    // A fallback or shared-source review can be required even when no consumer reads
    // the withdrawn definition. Only the resolver's direct impact can block removal.
    if (withdrawals?.size)
      for (const row of result.rows)
        for (const { globalId } of row.causes) {
          const removed = withdrawals.get(globalId);
          if (removed === null || removed?.includes(row.consumer.lang) || removed?.includes('en'))
            throw new Error('Sync pending: a removed global dependency is still referenced');
        }
    return expandReleaseDependencies(
      input,
      observedBefore,
      after,
      result,
      changes(input, ids, names).map((change) => change.cause),
      scans,
      withdrawals && ids.length > 1 ? () => fallbackAlternatives(observedBefore) : undefined,
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
  scans: GlobalSnapshotScans,
  counterfactuals?: () => ReadonlyMap<
    string,
    ReturnType<GlobalSnapshotScans['resolve']> | undefined
  >,
): GlobalImpact {
  const probe = [
    { kind: 'titles' as const, beforeName: 'Release', afterName: 'Release', cause: causes[0] },
  ];
  const census = calculateGlobalImpact(before, after, probe, input.destination, scans);
  if (!census.complete) throw new Error('Sync pending: import release closure is incomplete');
  const key = (row: GlobalImpactRow) => `${row.consumer.hash}:${row.consumer.lang}`;
  const rows = new Map(impact.rows.map((row) => [key(row), row]));
  // Aggregate timestamp fallback can change a second variable even when its own
  // definition did not change. Compare real renders while holding consumers fixed.
  const globalOnly = calculateGlobalImpact(
    before,
    {
      ...before,
      tooltips: {
        ...before.tooltips,
        ...Object.fromEntries(
          input.saved.aggregates.map(({ document }) => [
            document.hash,
            after.tooltips[document.hash],
          ]),
        ),
      },
    },
    probe,
    input.destination,
    scans,
  );
  if (!globalOnly.complete) throw new Error('Sync pending: global fallback closure is incomplete');
  let alternatives: ReturnType<NonNullable<typeof counterfactuals>> | undefined;
  for (const row of globalOnly.rows)
    if (row.before?.rendered !== row.after?.rendered && !rows.has(key(row))) {
      const actual = census.rows.find((candidate) => key(candidate) === key(row));
      if (!actual) continue;
      // Attribute fallback in the final release to edits needed to reproduce it,
      // including when a withdrawn cell never appeared in the published store.
      alternatives ??= counterfactuals?.();
      const attributable = causes.filter(({ globalId }) => {
        const alternative = alternatives?.get(globalId);
        return (
          !alternative ||
          alternative.blockers.size > 0 ||
          alternative.cells.get(key(row))?.result.rendered !== row.after?.rendered
        );
      });
      rows.set(key(actual), {
        ...actual,
        reason: 'variable-read',
        causes: [
          ...new Map(
            (attributable.length ? attributable : causes).map((cause) => [
              stableStringify(cause),
              cause,
            ]),
          ).values(),
        ],
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
        (hash === 1 && input.saved.aggregates.some((aggregate) => aggregate.document.hash === 1)) ||
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
        // An alias's shared source can release even when this particular render context
        // never reads the changed global. Membership is canonical on both sides; review
        // identity stays on the alias row, including across alias-map changes.
        resolveAlias(row.consumer.hash, before.aliases),
        resolveAlias(row.consumer.hash, after.aliases),
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
  const scans = new GlobalSnapshotScans();
  const complete = impacts(input, input.saved, changed, scans);
  for (const result of complete)
    for (const row of result.rows) join(row.causes.map((cause) => cause.globalId));
  const membership = new Map<string, Set<string>>();
  // Single-entry candidates expose fallback/dependency interactions hidden by a
  // simultaneous edit. Consumers shared by them form one coherent release group.
  for (const id of changed)
    for (const impact of impacts(
      input,
      composeGlobalRelease(input.published, input.saved, [id]),
      [id],
      scans,
    ))
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
        (['variables', 'titles', 'exports'] as const).flatMap((kind) =>
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
    const withdrawals = new Map<string, readonly Lang[] | null>();
    for (const entry of store.entries) {
      if (!group.has(entry.id)) continue;
      const previous = input.published.entries.find(({ id }) => id === entry.id);
      const removed = (Object.keys(previous?.definitions ?? {}) as Lang[]).filter(
        (lang) => !entry.definitions[lang],
      );
      if (entry.tombstone || removed.length)
        withdrawals.set(entry.id, entry.tombstone ? null : removed);
    }
    const contexts = impacts(input, store, ids, scans, withdrawals);
    const rows = new Map<string, GlobalReleaseRow>();
    for (const impact of contexts)
      for (const view of impact.rows) {
        const { hash, lang } = view.consumer;
        const saved = consumerDocument(input.authored, hash) ?? consumerDocument(input.live, hash);
        if (!saved) throw new Error('Deleted consumer dependency');
        const dependencies = new Set(
          [...(view.before?.reads.imports ?? []), ...(view.after?.reads.imports ?? [])].map(
            (read) => resolveAlias(read.hash, input.authored.aliases),
          ),
        );
        const dependencyDocuments: Record<string, Tooltip> = {};
        for (const dependency of dependencies) {
          const document = Object.hasOwn(projectGlobals(store), dependency)
            ? projectGlobals(store)[dependency]
            : (input.authored.tooltips[dependency] ?? input.live.tooltips[dependency]);
          if (!document) throw new Error('Deleted imported dependency');
          dependencyDocuments[dependency] = document;
        }
        const id = await globalIdentityDigest(view.consumer);
        // Both authored and actual prospective live contexts bind the one displayed review.
        const old = rows.get(id);
        const previous =
          consumerDocument(input.live, hash) ??
          input.priorAuthored
            ?.map(({ snapshot }) => consumerDocument(snapshot, hash))
            .find(Boolean) ??
          consumerDocument(input.authored, hash);
        const beforeSource = previous
          ? (globalSourceText(
              previous,
              lang,
              consumerDocument(input.live, hash) ? 'live' : 'authored',
            ) ?? '')
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
    // Reserved libraries are emitted from the candidate, never from saved aggregates.
    for (const aggregate of store.aggregates) hashes.add(aggregate.document.hash);
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
