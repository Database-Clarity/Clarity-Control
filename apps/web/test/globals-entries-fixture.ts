import {
  parseMarkup,
  validGlobalName,
  type GlobalDefinition,
  type GlobalReview,
} from '@clarity/core';
import {
  canEditGlobal,
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
  impacts: { g_damage0001: [consumer(10, 'en', 'live'), french], g_title00001: [] },
};

/** In-memory only; deliberately no HTTP or repository writes. */
export function createGlobalsFixture(actor: GlobalActor, seed = globalFixtureSnapshot) {
  const snapshot = structuredClone(seed);
  let revision = 1;
  const controls: { next?: 'retry' | 'conflict'; delay: number } = { delay: 0 };
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
      return (await failure<GlobalSnapshot>()) ?? { kind: 'ok', value: structuredClone(snapshot) };
    },
    async impact(request) {
      const failed = await failure<{ head: string; consumers: GlobalConsumer[] }>();
      if (failed) return failed;
      if (request.expectedHead !== snapshot.head)
        return { kind: 'conflict', message: 'Stale head.' };
      return {
        kind: 'ok',
        value: {
          head: snapshot.head,
          consumers: structuredClone(snapshot.impacts[request.id] ?? []).map((row) => ({
            ...row,
            after: render(`Projected value: ${request.body}`),
          })),
        },
      };
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
        for (const row of snapshot.impacts[entry!.id] ?? []) {
          delete row.review.acknowledgement;
          row.review.dependencyDigest = fixtureDigest(1000 + revision);
          row.impactDigest = fixtureDigest(2000 + revision);
          row.before = row.after;
          row.after = render(`Updated value: ${mutation.body}`);
        }
      } else if (mutation.operation === 'rename') {
        entry!.nameHistory.push({
          name: entry!.name,
          revision: entry!.revision,
          at: stamp,
          by: 'fixture',
        });
        entry!.name = mutation.name;
        entry!.revision = `r${++revision}`;
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
      snapshot.head = `fixture-head-${++revision}`;
      return { kind: 'ok', value: structuredClone(snapshot) };
    },
  };
  return { service, controls };
}
