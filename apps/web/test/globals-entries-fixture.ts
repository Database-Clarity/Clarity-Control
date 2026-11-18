import {
  globalAggregateHash,
  globalAggregateKind,
  parseMarkup,
  validGlobalName,
  type GlobalDefinition,
  type GlobalReview,
  type GlobalImpactSnapshot,
  type Tooltip,
} from '@clarity/core';
import {
  canEditGlobal,
  createGlobalsService,
  type GlobalsTransport,
  type GlobalHttpState,
  type GlobalSourcePins,
  canAcknowledgeGlobal,
  type GlobalProjectionSource,
  canReviewGlobal,
  type GlobalActor,
  type GlobalConsumer,
  type GlobalResult,
  type GlobalSnapshot,
} from '../src/services/globals';

export const fixtureHead = (value: number) => value.toString(16).padStart(40, '0');
export const fixtureSources: GlobalSourcePins = {
  authored: 'a'.repeat(40),
  definitions: 'b'.repeat(40),
  projections: 'c'.repeat(40),
  config: 'd'.repeat(40),
  live: 'e'.repeat(40),
  upcoming: 'f'.repeat(40),
  aliases: '1'.repeat(40),
  generator: '2'.repeat(40),
  fallback: 'a'.repeat(64),
  resolver: 'b'.repeat(64),
};
const stamp = '2026-01-01T00:00:00Z';
export const fixtureDigest = (value: number) => value.toString(16).padStart(64, '0');
function definition(
  body: string,
  lang: 'en' | 'fr',
  hash: 1 | 2 | 3,
  revision = 'r1',
): GlobalDefinition {
  return {
    body,
    revision,
    updatedAt: stamp,
    updatedBy: 'fixture',
    provenance: {
      repository: 'fixture',
      revision: 'source1',
      path: `tooltips/${hash}.json`,
      selector: ['text', lang, 'text'],
      spanConvention: 'decoded-utf16',
      hash,
      lang,
      from: 0,
      to: 1,
    },
  };
}
function render(text: string) {
  return {
    rendered: JSON.stringify(parseMarkup(text, { variables: '', titles: '' }).lines),
    reads: { imports: [], variables: ['Damage'], conservativeTitles: true as const },
  };
}
function consumer(hash: number, lang: 'en' | 'fr', destination: string): GlobalConsumer {
  const identity = { hash, lang, destination };
  const causes = [{ globalId: 'g_damage0001', beforeRevision: 'r0', afterRevision: 'r1' }];
  const review: GlobalReview = {
    version: 1,
    consumer: identity,
    causes,
    contentDigest: fixtureDigest(hash),
    dependencyDigest: fixtureDigest(100 + hash),
  };
  if (lang === 'fr')
    review.acknowledgement = {
      by: 'fixture',
      at: stamp,
      contentDigest: review.contentDigest,
      dependencyDigest: fixtureDigest(0),
      impactDigest: fixtureDigest(1),
      decision: 'no-text-change',
    };
  return {
    id: `review_${hash}_${lang}_${destination}`,
    consumer: identity,
    causes,
    reason: 'variable-read',
    variant: hash === 20 ? 21 : hash,
    name: hash === 10 ? 'Focused Fury' : 'Reservoir Burst',
    category: 'Perks',
    line: hash === 10 ? 3 : 1,
    path: hash === 10 ? ['Damage', 'Focused Fury'] : ['Damage', 'export Bonus', 'Reservoir Burst'],
    direct: hash === 10,
    archived: hash === 20,
    review,
    impactDigest: fixtureDigest(200 + hash),
    beforeSource: lang === 'en' ? 'Gain #Damage damage.' : 'import Bonus from global',
    afterSource: lang === 'en' ? 'Gain #Damage damage.' : 'import Bonus from global',
    before: render(lang === 'en' ? 'Gain 10% damage.' : 'Bonus de 10 %.'),
    after: render(lang === 'en' ? 'Gain 15% damage.' : 'Bonus de 15 %.'),
  };
}
const french = consumer(20, 'fr', 'saved');
french.causes.push({ globalId: 'g_other00001', beforeRevision: 'r2', afterRevision: 'r3' });
export const globalFixtureSnapshot: GlobalSnapshot = {
  head: fixtureHead(1),
  sources: fixtureSources,
  entries: [
    {
      version: 1,
      id: 'g_damage0001',
      kind: 'variables',
      name: 'Damage',
      revision: 'r1',
      nameHistory: [],
      definitions: {
        en: definition('15%', 'en', 2, 'en1'),
        fr: { ...definition('15 %', 'fr', 2, 'fr1'), sourceRevision: 'en0' },
      },
    },
    {
      version: 1,
      id: 'g_title00001',
      kind: 'titles',
      name: 'Reload',
      revision: 'r1',
      nameHistory: [],
      definitions: {
        en: definition('Reloads the weapon.', 'en', 3, 'en1'),
      },
    },
  ],
  sourceBodies: { g_damage0001: { fr: '10%' } },
  sync: {
    g_damage0001: { status: 'current', causeIds: [] },
    g_title00001: { status: 'current', causeIds: [] },
  },
  destinationSync: {
    live: { status: 'current', causeIds: [] },
    saved: { status: 'current', causeIds: [] },
  },
  impacts: { g_damage0001: [consumer(10, 'en', 'live'), french], g_title00001: [] },
};

/** In-memory only; deliberately no HTTP or repository writes. */
export function createGlobalsFixture(
  actor: GlobalActor,
  seed = globalFixtureSnapshot,
  largeProjection = false,
) {
  const snapshot = structuredClone(seed);
  let revision = 1;
  const controls: {
    next?: 'retry' | 'conflict';
    delay: number;
    syncOutcome?: 'current' | 'sync-failed';
  } = { delay: 0 };
  const queuedRenames = new Map<string, string>();
  async function failure<T>(): Promise<GlobalResult<T> | undefined> {
    if (controls.delay) await new Promise((resolve) => setTimeout(resolve, controls.delay));
    const next = controls.next;
    controls.next = undefined;
    if (next)
      return {
        kind: next,
        message:
          next === 'conflict'
            ? 'Revision conflict. Reload before continuing.'
            : 'Fixture request failed. Retry the action.',
      };
  }
  function header(): GlobalHttpState {
    const states = [...Object.values(snapshot.sync), ...Object.values(snapshot.destinationSync)];
    const failed = states.find((state) => state.status === 'sync-failed');
    const pending = states.find((state) => state.status === 'sync-pending');
    return {
      version: 1,
      head: snapshot.head,
      status: failed ? 'sync-failed' : pending ? 'sync-pending' : 'current',
      lastFailure: failed?.lastFailure ?? pending?.lastFailure ?? null,
      causeIds: [...new Set(states.flatMap((state) => state.causeIds))],
    };
  }
  function setSync(
    status: 'sync-pending' | 'sync-failed' | 'current',
    causeIds: string[],
    lastFailure: string | null = null,
  ) {
    for (const entry of snapshot.entries)
      snapshot.sync[entry.id] = { status, causeIds: [...causeIds], lastFailure };
    for (const destination of Object.keys(snapshot.destinationSync))
      snapshot.destinationSync[destination] = { status, causeIds: [...causeIds], lastFailure };
  }
  const transport: GlobalsTransport = {
    async list(cursor) {
      const failed = await failure<import('../src/services/globals').GlobalEntryPage>();
      if (failed) return failed;
      if (controls.syncOutcome) {
        const status = controls.syncOutcome;
        controls.syncOutcome = undefined;
        for (const state of [
          ...Object.values(snapshot.sync),
          ...Object.values(snapshot.destinationSync),
        ]) {
          state.status = status;
          if (status === 'sync-failed')
            state.lastFailure = 'Fixture sync failed: source changed during calculation.';
          else {
            state.lastFailure = null;
            state.causeIds = [];
          }
        }
        if (status === 'current') {
          for (const [id, name] of queuedRenames) {
            const entry = snapshot.entries.find((item) => item.id === id)!;
            entry.nameHistory.push({
              name: entry.name,
              revision: entry.revision,
              at: stamp,
              by: 'fixture',
            });
            entry.name = name;
            entry.revision = `r${++revision}`;
          }
          queuedRenames.clear();
          for (const entry of snapshot.entries)
            for (const row of snapshot.impacts[entry.id] ?? []) {
              if (row.review.acknowledgement) continue;
              row.before = row.after;
              row.after = render(
                `Updated value: ${entry.definitions[row.consumer.lang]?.body ?? ''}`,
              );
              row.review.dependencyDigest = fixtureDigest(1000 + revision);
              row.impactDigest = fixtureDigest(2000 + revision);
            }
        }
        snapshot.head = fixtureHead(++revision);
      }
      const offset = Number(cursor.slice(1)) * 3;
      return {
        kind: 'ok',
        value: {
          ...header(),
          entries: structuredClone(snapshot.entries.slice(offset, offset + 3)),
          nextCursor:
            offset + 3 < snapshot.entries.length ? `p${Number(cursor.slice(1)) + 1}` : null,
        },
      };
    },
    async entry(id) {
      const entry = snapshot.entries.find((item) => item.id === id);
      return entry
        ? { kind: 'ok', value: { ...header(), entry: structuredClone(entry) } }
        : { kind: 'invalid', message: 'Entry not found.' };
    },
    async reviews(id, cursor) {
      if (header().status !== 'current')
        return { kind: 'retry', message: 'Sync pending: saved reviews unavailable.' };
      const offset = Number(cursor.slice(1)) * 3;
      const rows = snapshot.impacts[id] ?? [];
      return {
        kind: 'ok',
        value: {
          ...header(),
          consumers: structuredClone(rows.slice(offset, offset + 3)),
          nextCursor: offset + 3 < rows.length ? `p${Number(cursor.slice(1)) + 1}` : null,
        },
      };
    },
    async retrySync(request) {
      const failed = await failure<import('../src/services/globals').GlobalEntryDelta>();
      if (failed) return failed;
      if (request.expectedHead !== snapshot.head)
        return { kind: 'conflict', message: 'Stale head.' };
      if (!actor) return { kind: 'forbidden', message: 'Sign in to retry sync.' };
      const state = header();
      if (!state || JSON.stringify(state.causeIds) !== JSON.stringify(request.causeIds))
        return { kind: 'conflict', message: 'Sync causes changed. Refresh before retrying.' };
      setSync('sync-pending', state.causeIds, state.lastFailure ?? null);
      snapshot.head = fixtureHead(++revision);
      return {
        kind: 'ok',
        value: {
          ...header(),
          entry: structuredClone(snapshot.entries.find((item) => item.id === request.id)!),
        },
      };
    },
    async mutate({ expectedHead, mutation }) {
      const failed = await failure<
        | import('../src/services/globals').GlobalEntryDelta
        | import('../src/services/globals').GlobalAuditDelta
      >();
      if (failed) return failed;
      if (expectedHead !== snapshot.head) return { kind: 'conflict', message: 'Stale head.' };
      const entry =
        'id' in mutation ? snapshot.entries.find((item) => item.id === mutation.id) : undefined;
      const forbidden = () => ({
        kind: 'forbidden' as const,
        message: 'This role cannot perform that action.',
      });
      if (!actor) return forbidden();
      if (mutation.operation !== 'create' && !entry)
        return { kind: 'invalid', message: 'Entry not found.' };
      if ('revision' in mutation && mutation.revision !== entry?.revision)
        return { kind: 'conflict', message: 'Stale entry revision.' };
      if (mutation.operation === 'create' || mutation.operation === 'rename') {
        if (
          actor.role === 'translator' ||
          (mutation.operation === 'rename' && actor.role === 'trial')
        )
          return forbidden();
        const kind = mutation.operation === 'create' ? mutation.kind : entry!.kind;
        if (
          !validGlobalName(kind, mutation.name) ||
          snapshot.entries.some(
            (item) => item.id !== entry?.id && item.kind === kind && item.name === mutation.name,
          )
        )
          return { kind: 'invalid', message: 'Choose a valid, unique reference name.' };
      }
      if (mutation.operation === 'create') {
        if (mutation.kind !== 'variables' && !mutation.body.trim())
          return { kind: 'invalid', message: 'Title body is required.' };
        snapshot.entries.push({
          version: 1,
          nameHistory: [],
          id: `g_fixture${String(++revision).padStart(8, '0')}`,
          kind: mutation.kind,
          name: mutation.name,
          revision: `r${revision}`,
          definitions: {
            [mutation.lang]: definition(
              mutation.body,
              mutation.lang as 'en' | 'fr',
              globalAggregateHash(mutation.kind),
              `body${revision}`,
            ),
          },
        });
      } else if (mutation.operation === 'edit') {
        if (!canEditGlobal(actor, mutation.lang)) return forbidden();
        if (entry!.kind !== 'variables' && !mutation.body.trim())
          return { kind: 'invalid', message: 'Title body is required.' };
        entry!.definitions[mutation.lang] = {
          ...definition(
            mutation.body,
            mutation.lang as 'en' | 'fr',
            globalAggregateHash(entry!.kind),
            `body${++revision}`,
          ),
          provenance:
            entry!.definitions[mutation.lang]?.provenance ??
            definition(
              mutation.body,
              mutation.lang as 'en' | 'fr',
              globalAggregateHash(entry!.kind),
            ).provenance,
        };
        entry!.revision = `r${revision}`;
        for (const row of snapshot.impacts[entry!.id] ?? []) delete row.review.acknowledgement;
      } else if (mutation.operation === 'rename') {
        queuedRenames.set(entry!.id, mutation.name);
      } else if (mutation.operation === 'remove') {
        if (actor.role !== 'maintainer') return forbidden();
        if (snapshot.impacts[entry!.id]?.length)
          return { kind: 'invalid', message: 'References still exist.' };
        if (mutation.lang) delete entry!.definitions[mutation.lang];
        else entry!.tombstone = { at: stamp, by: 'fixture' };
        entry!.revision = `r${++revision}`;
      } else {
        const row = snapshot.impacts[entry!.id]?.find((item) => item.id === mutation.consumerId);
        if (
          !row ||
          row.review.contentDigest !== mutation.contentDigest ||
          row.review.dependencyDigest !== mutation.dependencyDigest ||
          row.impactDigest !== mutation.impactDigest
        )
          return { kind: 'conflict', message: 'Review is stale.' };
        if (!canAcknowledgeGlobal(snapshot, entry!.id, row))
          return {
            kind: 'invalid',
            message: 'Sync must finish and the saved review must be current.',
          };
        if (!canReviewGlobal(actor, row.consumer.lang)) return forbidden();
        row.review.acknowledgement = {
          by: 'fixture',
          at: stamp,
          contentDigest: mutation.contentDigest,
          dependencyDigest: mutation.dependencyDigest,
          impactDigest: mutation.impactDigest,
          decision: mutation.decision,
        };
      }
      if (mutation.operation !== 'acknowledge') {
        const causeId = `cause-${++revision}`;
        const causeIds = [...header().causeIds, causeId];
        setSync('sync-pending', causeIds, header().lastFailure ?? null);
      }
      snapshot.head = fixtureHead(++revision);
      if (mutation.operation === 'acknowledge') {
        const row = snapshot.impacts[mutation.id].find((item) => item.id === mutation.consumerId)!;
        return {
          kind: 'ok',
          value: { ...header(), consumerId: row.id, review: structuredClone(row.review) },
        };
      }
      const changed = mutation.operation === 'create' ? snapshot.entries.at(-1)! : entry!;
      return {
        kind: 'ok',
        value: {
          ...header(),
          entry: structuredClone(changed),
          ...(mutation.operation === 'rename'
            ? { renameCompleted: false as const, intentId: `intent-${revision}` }
            : {}),
        },
      };
    },
  };
  const extraTooltips: Record<string, Tooltip> = {};
  if (largeProjection)
    for (let hash = 100; hash < 3100; hash++)
      extraTooltips[hash] = {
        hash,
        associated: [],
        text: { en: { text: 'Gain #Damage damage.', updatedAt: stamp, updatedBy: 'fixture' } },
      };
  const projection: GlobalProjectionSource = {
    prepare(request) {
      const entry = snapshot.entries.find((item) => item.id === request.id)!;
      const aggregate = (hash: 1 | 2 | 3, changed: boolean): Tooltip => {
        const text: Tooltip['text'] = {};
        for (const lang of ['en', 'fr'] as const) {
          const source = snapshot.entries
            .filter((item) => !item.tombstone && item.kind === globalAggregateKind(hash))
            .flatMap((item) => {
              const body =
                changed && item.id === request.id && lang === request.lang
                  ? request.body
                  : item.definitions[lang]?.body;
              if (body === undefined) return [];
              return hash === 2
                ? [`var ${item.name} = ${body || 'empty'}`]
                : [`${hash === 1 ? 'export' : 'title'} ${item.name} (\n${body}\n)`];
            })
            .join('\n');
          if (source) text[lang] = { text: source, updatedAt: stamp, updatedBy: 'fixture' };
        }
        return { hash, associated: [], text };
      };
      const tooltips: Record<string, Tooltip> = {
        ...extraTooltips,
        1: {
          hash: 1,
          associated: [],
          text: {
            fr: {
              text: 'export Bonus (\nBonus de #Damage.\n)',
              updatedAt: stamp,
              updatedBy: 'fixture',
            },
          },
        },
        2: aggregate(2, false),
        3: aggregate(3, false),
        10: {
          hash: 10,
          associated: [],
          text: { en: { text: 'Gain #Damage damage.', updatedAt: stamp, updatedBy: 'fixture' } },
        },
        20: {
          hash: 20,
          associated: [],
          text: {
            fr: { text: 'import Bonus from global', updatedAt: stamp, updatedBy: 'fixture' },
          },
        },
      };
      const before: GlobalImpactSnapshot = {
        repository: 'fixture',
        revision: request.expectedHead,
        tooltips,
        aliases: {},
        types: Object.fromEntries(Object.keys(tooltips).map((hash) => [hash, 'perk'])),
        mode: 'authored',
      };
      if (snapshot.entries.some((item) => item.kind === 'exports')) {
        tooltips[1] = aggregate(1, false);
        tooltips[30] = {
          hash: 30,
          associated: [],
          text: {
            en: {
              text: `import ${snapshot.entries.find((item) => item.kind === 'exports')!.name} from global`,
              updatedAt: stamp,
              updatedBy: 'fixture',
            },
          },
        };
        before.types = { ...before.types, 30: 'perk' };
      }
      return {
        before,
        after: {
          ...before,
          revision: 'draft',
          tooltips: {
            ...tooltips,
            [globalAggregateHash(entry.kind)]: aggregate(globalAggregateHash(entry.kind), true),
          },
        },
        destination: 'saved',
        changes: [
          {
            cause: { globalId: entry.id, beforeRevision: entry.revision, afterRevision: 'draft' },
            kind: entry.kind,
            beforeName: entry.name,
            afterName: entry.name,
            languages: [request.lang],
          },
        ],
      };
    },
    describe(row, input) {
      const saved = Object.values(snapshot.impacts)
        .flat()
        .find(
          (item) =>
            item.consumer.hash === row.consumer.hash && item.consumer.lang === row.consumer.lang,
        );
      return {
        ...row,
        id: `projected:${row.consumer.hash}:${row.consumer.lang}:${row.consumer.destination}`,
        name: saved?.name ?? `Tooltip ${row.consumer.hash}`,
        category: saved?.category ?? 'Fixture',
        variant: saved?.variant ?? row.consumer.hash,
        line: saved?.line ?? null,
        path: saved?.path ?? null,
        direct: saved?.direct ?? null,
        archived: saved?.archived ?? false,
        beforeSource: input.before.tooltips[row.consumer.hash]?.text[row.consumer.lang]?.text ?? '',
        afterSource: input.after.tooltips[row.consumer.hash]?.text[row.consumer.lang]?.text ?? '',
      };
    },
  };
  const service = createGlobalsService(transport, {
    destinations: ['live', 'saved'],
    initialSnapshot: seed,
  });
  return { service, transport, controls, projection };
}
