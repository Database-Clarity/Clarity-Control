import type { GlobalDefinition } from '@clarity/core';
import { createGlobalsService, type GlobalSnapshot, type GlobalsTransport } from '../src/services/globals';

export const fixtureHead = (value: number) => value.toString(16).padStart(40, '0');
const stamp = '2026-01-01T00:00:00Z';
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
export const globalFixtureSnapshot: GlobalSnapshot = {
  head: fixtureHead(1),
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
};

/** Local catalogue and entry state for service tests. */
export function createGlobalsFixture(seed = globalFixtureSnapshot) {
  const snapshot = structuredClone(seed);
  let revision = 1;
  const catalog = async () => ({
    kind: 'ok' as const,
    value: { head: snapshot.head, entries: structuredClone(snapshot.entries) },
  });
  const transport: GlobalsTransport = {
    async entry(id) {
      const entry = snapshot.entries.find((item) => item.id === id);
      return entry
        ? { kind: 'ok', value: { head: snapshot.head, entry: structuredClone(entry), causeIds: [] } }
        : { kind: 'invalid', message: 'Unknown entry.' };
    },
    async mutate({ expectedHead, mutation }) {
      if (expectedHead !== snapshot.head) return { kind: 'conflict', message: 'Source head changed.' };
      if (mutation.operation !== 'edit') return { kind: 'invalid', message: 'Expected an edit.' };
      const entry = snapshot.entries.find(({ id }) => id === mutation.id);
      if (!entry || entry.revision !== mutation.revision)
        return { kind: 'conflict', message: 'Entry changed.' };
      entry.definitions[mutation.lang] = {
        ...entry.definitions[mutation.lang],
        body: mutation.body,
        revision: String(++revision),
        updatedAt: stamp,
        updatedBy: 'fixture',
      };
      entry.revision = String(revision);
      snapshot.head = fixtureHead(revision);
      return transport.entry(entry.id);
    },
  };
  const service = createGlobalsService(transport, { catalog, initialSnapshot: seed });
  return { transport, catalog, service };
}
