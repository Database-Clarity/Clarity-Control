import {
  canEditGlobal,
  canReviewGlobal,
  type GlobalActor,
  type GlobalConsumer,
  type GlobalResult,
  type GlobalSnapshot,
  type GlobalsService,
} from '../src/services/globals';

export const globalFixtureSnapshot: GlobalSnapshot = {
  head: 'fixture-head-1',
  entries: [
    {
      id: 'global-damage',
      kind: 'variable',
      name: 'Damage',
      revision: 'r1',
      definitions: {
        en: { body: '15%', revision: 'en1' },
        fr: { body: '15 %', revision: 'fr1', sourceRevision: 'en0', sourceBody: '10%' },
      },
    },
    {
      id: 'global-title',
      kind: 'title',
      name: 'Reload',
      revision: 'r1',
      definitions: {
        en: { body: 'Reloads the weapon.', revision: 'en1' },
      },
    },
  ],
  impacts: {
    'global-damage': [
      {
        id: '10:en:live',
        hash: 10,
        variant: 10,
        name: 'Focused Fury',
        category: 'Perks',
        lang: 'en',
        destination: 'live',
        line: 3,
        path: ['Damage', 'Focused Fury'],
        direct: true,
        archived: false,
        contentRevision: 'tooltip1',
        dependencyDigest: 'digest1',
        review: 'required',
        causes: [{ globalId: 'global-damage', beforeRevision: 'r0', afterRevision: 'r1' }],
        before: { source: 'Gain #Damage damage.', resolved: 'Gain 10% damage.' },
        after: { source: 'Gain #Damage damage.', resolved: 'Gain 15% damage.' },
      },
      {
        id: '20:fr:saved',
        hash: 20,
        variant: 21,
        name: 'Reservoir Burst',
        category: 'Perks',
        lang: 'fr',
        destination: 'saved',
        line: 1,
        path: ['Damage', 'export Bonus', 'Reservoir Burst'],
        direct: false,
        archived: true,
        contentRevision: 'tooltip2',
        dependencyDigest: 'digest2',
        review: 'stale',
        causes: [
          { globalId: 'global-damage', beforeRevision: 'r0', afterRevision: 'r1' },
          { globalId: 'other-global', beforeRevision: 'r2', afterRevision: 'r3' },
        ],
        before: { source: 'import Bonus from global', resolved: 'Bonus de 10 %.' },
        after: { source: 'import Bonus from global', resolved: 'Bonus de 15 %.' },
      },
    ],
    'global-title': [],
  },
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
            after: { ...row.after, resolved: `Projected value: ${request.body}` },
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
          !(kind === 'variable' ? /^[a-zA-Z0-9]+$/ : /^[a-zA-Z0-9 ]+$/).test(mutation.name) ||
          snapshot.entries.some(
            (item) => item.id !== entry?.id && item.kind === kind && item.name === mutation.name,
          )
        )
          return { kind: 'invalid', message: 'Choose a valid, unique reference name.' };
      }
      if (mutation.operation === 'create') {
        if (mutation.kind === 'title' && !mutation.body.trim())
          return { kind: 'invalid', message: 'Title body is required.' };
        snapshot.entries.push({
          id: `fixture-${++revision}`,
          kind: mutation.kind,
          name: mutation.name,
          revision: `r${revision}`,
          definitions: { [mutation.lang]: { body: mutation.body, revision: `body${revision}` } },
        });
      } else if (mutation.operation === 'edit') {
        if (!canEditGlobal(actor, mutation.lang)) return forbidden();
        if (entry!.kind === 'title' && !mutation.body.trim())
          return { kind: 'invalid', message: 'Title body is required.' };
        entry!.definitions[mutation.lang] = { body: mutation.body, revision: `body${++revision}` };
        entry!.revision = `r${revision}`;
        for (const row of snapshot.impacts[entry!.id] ?? []) {
          row.review = 'required';
          row.dependencyDigest = `digest${revision}`;
        }
      } else if (mutation.operation === 'rename') {
        entry!.name = mutation.name;
        entry!.revision = `r${++revision}`;
      } else if (mutation.operation === 'remove') {
        if (actor.role !== 'maintainer') return forbidden();
        if (snapshot.impacts[entry!.id]?.length)
          return { kind: 'invalid', message: 'References still exist.' };
        if (mutation.lang) delete entry!.definitions[mutation.lang];
        else snapshot.entries = snapshot.entries.filter((item) => item.id !== entry!.id);
      } else {
        const row = snapshot.impacts[entry!.id]?.find((item) => item.id === mutation.consumerId);
        if (
          !row ||
          row.contentRevision !== mutation.contentRevision ||
          row.dependencyDigest !== mutation.dependencyDigest
        )
          return { kind: 'conflict', message: 'Review is stale.' };
        if (!canReviewGlobal(actor, row.lang)) return forbidden();
        row.review = 'acknowledged';
      }
      snapshot.head = `fixture-head-${++revision}`;
      return { kind: 'ok', value: structuredClone(snapshot) };
    },
  };
  return { service, controls };
}
