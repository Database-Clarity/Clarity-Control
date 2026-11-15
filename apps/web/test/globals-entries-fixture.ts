import {
  parseMarkup,
  validGlobalName,
  type GlobalDefinition,
  type GlobalReview,
  type GlobalImpactSnapshot,
  type Tooltip,
} from '@clarity/core';
import {
  canEditGlobal,
  canAcknowledgeGlobal,
  type GlobalProjectionSource,
  canReviewGlobal,
  type GlobalActor,
  type GlobalConsumer,
  type GlobalResult,
  type GlobalSnapshot,
  type GlobalsService,
} from '../src/services/globals';

const stamp = '2026-01-01T00:00:00Z';
export const fixtureDigest = (value: number) => value.toString(16).padStart(64, '0');
function definition(
  body: string,
  lang: 'en' | 'fr',
  hash: 2 | 3,
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
    id: `${hash}:${lang}:${destination}`,
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
  head: 'fixture-head-1',
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
  const service: GlobalsService = {
    async read() {
      const failed = await failure<GlobalSnapshot>();
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
          else delete state.lastFailure;
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
        snapshot.head = `fixture-head-${++revision}`;
      }
      return { kind: 'ok', value: structuredClone(snapshot) };
    },
    async retrySync(request) {
      const failed = await failure<GlobalSnapshot>();
      if (failed) return failed;
      if (request.expectedHead !== snapshot.head)
        return { kind: 'conflict', message: 'Stale head.' };
      if (!actor) return { kind: 'forbidden', message: 'Sign in to retry sync.' };
      const state = snapshot.sync[request.id];
      if (!state || JSON.stringify(state.causeIds) !== JSON.stringify(request.causeIds))
        return { kind: 'conflict', message: 'Sync causes changed. Refresh before retrying.' };
      state.status = 'sync-pending';
      for (const target of Object.values(snapshot.destinationSync)) target.status = 'sync-pending';
      snapshot.head = `fixture-head-${++revision}`;
      return { kind: 'ok', value: structuredClone(snapshot) };
    },
    async mutate({ expectedHead, mutation }) {
      const failed = await failure<GlobalSnapshot>();
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
        if (mutation.kind === 'titles' && !mutation.body.trim())
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
              mutation.kind === 'variables' ? 2 : 3,
              `body${revision}`,
            ),
          },
        });
      } else if (mutation.operation === 'edit') {
        if (!canEditGlobal(actor, mutation.lang)) return forbidden();
        if (entry!.kind === 'titles' && !mutation.body.trim())
          return { kind: 'invalid', message: 'Title body is required.' };
        entry!.definitions[mutation.lang] = {
          ...definition(
            mutation.body,
            mutation.lang as 'en' | 'fr',
            entry!.kind === 'variables' ? 2 : 3,
            `body${++revision}`,
          ),
          provenance:
            entry!.definitions[mutation.lang]?.provenance ??
            definition(
              mutation.body,
              mutation.lang as 'en' | 'fr',
              entry!.kind === 'variables' ? 2 : 3,
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
        const id = mutation.operation === 'create' ? snapshot.entries.at(-1)!.id : entry!.id;
        const causeId = `cause-${++revision}`;
        const causeIds = [...(snapshot.sync[id]?.causeIds ?? []), causeId];
        snapshot.sync[id] = { status: 'sync-pending', causeIds };
        for (const target of Object.values(snapshot.destinationSync)) {
          target.status = 'sync-pending';
          target.causeIds.push(causeId);
        }
      }
      snapshot.head = `fixture-head-${++revision}`;
      return { kind: 'ok', value: structuredClone(snapshot) };
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
      const aggregate = (hash: 2 | 3, changed: boolean): Tooltip => {
        const text: Tooltip['text'] = {};
        for (const lang of ['en', 'fr'] as const) {
          const source = snapshot.entries
            .filter(
              (item) => !item.tombstone && item.kind === (hash === 2 ? 'variables' : 'titles'),
            )
            .flatMap((item) => {
              const body =
                changed && item.id === request.id && lang === request.lang
                  ? request.body
                  : item.definitions[lang]?.body;
              if (body === undefined) return [];
              return hash === 2
                ? [`var ${item.name} = ${body || 'empty'}`]
                : [`title ${item.name} (\n${body}\n)`];
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
      return {
        before,
        after: {
          ...before,
          revision: 'draft',
          tooltips: {
            ...tooltips,
            [entry.kind === 'variables' ? 2 : 3]: aggregate(
              entry.kind === 'variables' ? 2 : 3,
              true,
            ),
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
  return { service, controls, projection };
}
