import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  aliasGroupsPath,
  composeAliases,
  emptyAliasGroups,
  inactiveMovesPath,
  exportLegacy,
  inactiveRemovalHash,
  legacyDatabaseSchema,
  migrateLegacy,
  parseMarkup,
  publishableHash,
  resolveAlias,
  sandboxPointersPath,
  type AliasGroups,
  type AliasItems,
  type Tooltip,
} from '@clarity/core';
import { batchSchema, schedulePaths } from '@clarity/core/schedule';
import publisherConfig from '../../../config/publisher.json';
import scheduledConfig from '../../../config/scheduled.json';
import { aliasCatalog, scopedAliases } from '../src/catalog.js';
import { refuseBaseEnhanced } from '../src/baseEnhanced.js';
import { GitHub } from '../src/github.js';
import { consumerAliasScope, withSandboxPointers } from '../src/sandboxPointers.js';
import { Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

const OP = '01K95H00000000000000000001';
const BATCH = '01K95H00000000000000000B01';
const time = [...OP.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
const revision = sha(800);
const by = { id: '1', login: 'alice' };
const at = '2026-11-01T00:00:00Z';
const document = (hash: number, text = 'Canonical text'): Tooltip => ({ ...tooltip(text), hash });
const groups = (canonical = 123, members = [123, 124, 125]): AliasGroups => ({
  ...emptyAliasGroups(),
  groups: {
    [canonical]: {
      members,
      kind: 'S',
      basis: { name: 'Twin', categoryId: 'weapon-trait' },
      by,
      at,
    },
  },
});
let key: string;
let f: Fixture;
let items: Record<string, AliasItems[string]>;
let generatorReads: string[];
let readHeads: string[];
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  publisherConfig.enabled = true;
  scheduledConfig.enabled = true;
  vi.useFakeTimers({ toFake: ['Date'], now: time });
  f = new Fixture(key);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  f.aliases = {};
  items = Object.fromEntries(
    [123, 124, 125, 126, 127, 128].map((hash) => [
      hash,
      {
        hash,
        name: 'Twin',
        categoryId: 'weapon-trait',
        inGameDescription: 'Same description',
        plugCategoryHash: 20,
        isEnhanced: false,
        exotic: false,
      },
    ]),
  );
  generatorReads = [];
  readHeads = [];
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes('/generator/commits/')) {
      f.subrequests++;
      return Response.json({ sha: revision });
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      generatorReads.push(url.pathname);
      f.subrequests++;
      const file = url.pathname.split('/').at(-1);
      return Response.json(
        file === 'items.json'
          ? items
          : file === 'categories.json'
            ? [{ id: 'weapon-trait', legacyType: 'Weapon Trait' }]
            : file === 'aliases.json'
              ? f.aliases
              : f.sandboxConflicts,
      );
    }
    if (url.pathname === '/graphql' && init?.body) {
      const value = JSON.parse(String(init.body)) as { variables: Record<string, string> };
      for (const [name, valueAt] of Object.entries(value.variables))
        if (/^e\d+$/.test(name)) readHeads.push(valueAt.split(':')[0]!);
    }
    return original(input, init);
  });
  f.moveData({
    [aliasGroupsPath]: groups(),
    'tooltips/123.json': document(123),
    '.publisher/PIN': {
      capabilities: ['aliasGroups', 'sandboxPointers', 'scheduledBatches', 'inactiveMoves'],
    },
  });
});
afterEach(() => {
  publisherConfig.enabled = false;
  scheduledConfig.enabled = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const aliases = () =>
  composeAliases(f.aliases, f.current()[aliasGroupsPath] as AliasGroups, items).aliases;
const publish = async (hash = 124, expected?: string) =>
  f.request('/publish', 'POST', {
    opId: OP,
    hashes: [hash],
    expected: { [hash]: expected ?? (await publishableHash(document(123), aliases())) },
  });
const save = (hash: number, base: Tooltip | null = null) =>
  f.request('/save', 'POST', {
    changes: [
      {
        hash,
        base,
        next: {
          ...document(hash, 'Edited'),
          text: {
            en: { ...document(hash, 'Edited').text.en!, updatedAt: '2026-10-01T00:00:02Z' },
          },
        },
      },
    ],
    message: 'Edit tooltip',
  });
function batch(hash = 124) {
  const record = batchSchema.parse({
    id: BATCH,
    name: 'Alias batch',
    createdBy: { id: 1, login: 'alice' },
    createdAt: at,
    revision: 1,
    contentRevision: 1,
    status: 'draft',
    notBefore: null,
    zone: null,
    opId: null,
    scheduledContentRevision: null,
    claim: null,
    result: null,
    events: [],
  });
  f.moveData({
    [schedulePaths.batch(BATCH)]: record,
    [schedulePaths.member(BATCH, hash)]: {
      hash,
      base: null,
      baseCommit: f.dataHead,
      proposed: document(hash),
      updatedAt: at,
      updatedBy: 'alice',
    },
  });
}

it('loads every authoritative fact and all grouping files from one generator revision', async () => {
  items[123] = {
    ...items[123]!,
    isEnhanced: true,
    exotic: true,
    baseHash: 126,
    dimBaseHash: 127,
    itemHash: 200,
    owners: [200, 201],
  };
  const loaded = await aliasCatalog(new GitHub(f.env));
  expect(loaded.items[123]).toEqual(items[123]);
  expect(loaded.revision).toBe(revision);
  expect(generatorReads).toHaveLength(3);
  expect(generatorReads.every((path) => path.includes(`/${revision}/`))).toBe(true);
});

it('requires complete authoritative descriptions for grouping', async () => {
  const invalid: Partial<AliasItems[string]> = { ...items[124] };
  delete invalid.inGameDescription;
  items[124] = invalid as AliasItems[string];
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await save(124)).status).toBe(502);
    expect(f.commits).toHaveLength(0);
  } finally {
    logged.mockRestore();
  }
});

it('keeps cross-category groups disabled and excludes enhanced/base drift', async () => {
  const input = groups();
  input.groups[123]!.kind = 'X';
  f.moveData({ [aliasGroupsPath]: input });
  expect((await publish(124, 'a'.repeat(64))).status).toBe(409);
  f.moveData({ [aliasGroupsPath]: groups() });
  items[124]!.isEnhanced = true;
  expect((await publish(124, 'a'.repeat(64))).status).toBe(409);
});

it('validates new sandbox picks against grouped canonical targets and pinned candidates', async () => {
  f.sandboxConflicts = { 700: [124, 126] };
  const response = await f.request('/sandbox-pointers', 'PUT', {
    revision: null,
    picks: { 700: { to: 123 } },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(f.current()[sandboxPointersPath]).toMatchObject({ pointers: { 700: { to: 123 } } });
  expect(
    generatorReads
      .filter((path) => path.endsWith('sandboxConflicts.json'))
      .every((path) => path.includes(`/${revision}/`)),
  ).toBe(true);
});

it('rejects alias saves with canonical guidance, without recreating an archived tooltip', async () => {
  const response = await save(124);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('canonical tooltip 123'),
  });
  expect(f.current()['tooltips/124.json']).toBeUndefined();
  expect(f.commits).toHaveLength(0);
});

it('re-reads groups and tooltips after a save CAS race', async () => {
  vi.setSystemTime(Date.parse('2026-11-15T00:00:00Z'));
  const base = document(124);
  f.moveData({ [aliasGroupsPath]: undefined, 'tooltips/124.json': base });
  const oldHead = f.dataHead;
  f.beforePatch = () => f.moveData({ [aliasGroupsPath]: groups(), 'tooltips/124.json': undefined });
  const response = await save(124, base);
  const result = await response.json();
  expect(response.status).toBe(422);
  expect(f.current()['tooltips/124.json'], JSON.stringify(result)).toBeUndefined();
  expect(readHeads).toContain(oldHead);
  expect(readHeads).toContain(f.dataHead);
});

it('publishes a member using the canonical tooltip and reviewed digest', async () => {
  const head = f.dataHead;
  expect((await publish()).status).toBe(202);
  expect(readHeads.every((value) => value === head)).toBe(true);
  expect(
    generatorReads
      .filter((path) => !path.endsWith('aliases.json'))
      .every((path) => path.includes(`/${revision}/`)),
  ).toBe(true);
});

it('rejects stale reviewed digests after group membership changes', async () => {
  const reviewed = await publishableHash(document(123), aliases());
  f.moveData({ [aliasGroupsPath]: groups(123, [123, 124]) });
  expect((await publish(124, reviewed)).status).toBe(409);
  expect(f.commits).toHaveLength(0);
});

it('re-checks capability and group membership after an ambiguous publish create', async () => {
  f.beforePatch = () => f.moveData({ '.publisher/PIN': { capabilities: [] } });
  expect((await publish()).status).toBe(409);
  expect(f.current()[`publish/requests/${OP}.json`]).toBeUndefined();
});

it.each([null, {}, { capabilities: ['sandboxPointers'] }])(
  'refuses a publisher that cannot compose groups (%j)',
  async (pin) => {
    f.moveData({ '.publisher/PIN': pin ?? undefined });
    expect((await publish()).status).toBe(409);
    expect(f.commits).toHaveLength(0);
  },
);

it.each([{}, { version: 1, groups: {}, rejected: {}, unexpected: true }])(
  'fails closed on malformed groups (%j)',
  async (value) => {
    f.moveData({ [aliasGroupsPath]: value });
    expect((await save(124)).status).toBe(502);
    expect((await publish(124, 'a'.repeat(64))).status).toBe(502);
    publisherConfig.enabled = false;
    expect((await f.request('/push-live', 'POST', { hashes: [123] })).status).toBe(502);
  },
);

it('honors generator drift and generated-alias precedence', async () => {
  items[124]!.name = 'Renamed';
  expect((await publish()).status).toBe(409);
  f.aliases = { 124: { to: 123, kind: 'frame' } };
  expect((await publish()).status).toBe(202);
});

it('checks canonical nested imports, global documents, and associated targets', async () => {
  f.moveData({
    'tooltips/123.json': document(123, 'import main from 126'),
    'tooltips/126.json': document(126, 'import main from global'),
    'tooltips/1.json': document(1, '{{old enhanced syntax}}'),
  });
  let expected = await publishableHash(f.current()['tooltips/123.json'] as Tooltip, aliases());
  expect((await publish(124, expected)).status).toBe(422);
  f.moveData({
    'tooltips/1.json': undefined,
    'tooltips/3.json': document(3, '{{held global title}}'),
  });
  expect((await publish(124, expected)).status).toBe(422);
  f.moveData({
    'tooltips/3.json': undefined,
    'tooltips/123.json': { ...document(123), associated: [128] },
    'tooltips/128.json': document(128, ''),
  });
  expected = await publishableHash(f.current()['tooltips/123.json'] as Tooltip, aliases());
  expect((await publish(124, expected)).status).toBe(422);
});

it('extends the existing dependency walker into another group with full-composition parity', async () => {
  items[129] = { ...items[123]!, hash: 129, name: 'Other twin' };
  items[130] = { ...items[129], hash: 130 };
  const input = groups();
  input.groups[129] = {
    ...input.groups[123]!,
    members: [129, 130],
    basis: { name: 'Other twin', categoryId: 'weapon-trait' },
  };
  f.moveData({
    [aliasGroupsPath]: input,
    'tooltips/123.json': document(123, 'import main from 130'),
    'tooltips/129.json': document(129, 'import main from 126'),
    'tooltips/126.json': document(126, 'Nested canonical'),
  });
  const github = new GitHub(f.env);
  const file = { sha: sha(90), value: input };
  const scope = (await consumerAliasScope(github, file, null, [123]))!;
  expect(scope.aliases[130]).toBeUndefined();
  const checked = await refuseBaseEnhanced(github, f.dataHead, [123], scope.aliases, [], scope);
  const full = composeAliases({}, input, items).aliases;
  const expected = await refuseBaseEnhanced(github, f.dataHead, [123], full);
  expect([...checked]).toEqual([...expected]);
  expect(resolveAlias(130, scope.aliases)).toBe(resolveAlias(130, full));
  expect(checked.get(126)?.text.en?.text).toBe('Nested canonical');
});

it('matches full S1 composition for each scoped synthetic identity and its incoming stubs', () => {
  f.aliases = { 900: { to: 124, kind: 'frame' }, 901: { to: 900, kind: 'sandbox' } };
  const full = composeAliases(f.aliases, groups(), items).aliases;
  for (const hash of [...Object.keys(items), ...Object.keys(f.aliases)].map(Number)) {
    const scope = scopedAliases(
      { items, aliases: f.aliases, conflicts: {}, categories: [] },
      groups(),
      null,
    );
    const selected = scope.extend([hash]);
    expect(resolveAlias(hash, selected)).toBe(resolveAlias(hash, full));
    const target = resolveAlias(hash, full);
    expect(
      Object.entries(selected).filter(([key]) => resolveAlias(Number(key), selected) === target),
    ).toEqual(Object.entries(full).filter(([key]) => resolveAlias(Number(key), full) === target));
  }
});

it('uses real resolver output for nested imports, deleted cells, cycles, and globals', () => {
  const effective = aliases();
  const text: Record<string, string> = {
    123: 'Canonical text',
    126: 'import main from 124',
    127: 'import main from 127',
  };
  const imports = Object.fromEntries(
    [...Object.keys(text), ...Object.keys(effective)].map((hash) => [
      hash,
      text[resolveAlias(Number(hash), effective)] ?? '',
    ]),
  );
  const context = { imports, variables: '#d=5', titles: 'main=Title' };
  expect(parseMarkup('import main from 126', context)).toEqual(
    parseMarkup('Canonical text', context),
  );
  expect(parseMarkup('import main from 127', context).diagnostics).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('cycle') }),
  );
  expect(parseMarkup('import main from 129', context).diagnostics).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('Unresolved import') }),
  );
});

it('follows shared sandbox targets through groups, while refusing shared group identities', async () => {
  f.sandboxConflicts = { 700: [124, 126] };
  f.moveData({
    [sandboxPointersPath]: {
      version: 1,
      pointers: {
        700: { to: 124, candidates: [124, 126], by: 1, at },
      },
    },
  });
  const merged = composeAliases(
    {},
    groups(),
    items,
    f.sandboxConflicts,
    f.current()[sandboxPointersPath] as Parameters<typeof composeAliases>[4],
  ).aliases;
  expect((await publish(700, await publishableHash(document(123), merged))).status).toBe(202);
  f.sandboxConflicts = { 124: [123, 126] };
  expect((await save(125)).status).toBe(502);
});

it('keeps inactive removal intent on the canonical identity', async () => {
  f.moveData({ [inactiveMovesPath]: { 123: { at, by: 1 } } });
  const response = await publish(124, await inactiveRemovalHash(123));
  expect(response.status).toBe(202);
});

it('preserves all 2,761 real fixture outputs when groups and picks are absent', async () => {
  const source = legacyDatabaseSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../packages/core/test/fixtures/intermediate.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const tooltips = migrateLegacy(source);
  expect(tooltips).toHaveLength(2761);
  const effective = await withSandboxPointers(new GitHub(f.env), {}, null, null);
  expect(exportLegacy(tooltips, 0, undefined, effective)).toEqual(exportLegacy(tooltips, 0));
});

it('pushes canonical output and repairs obsolete name stubs after recanonicalization and ungroup', async () => {
  publisherConfig.enabled = false;
  expect((await f.request('/push-live', 'POST', { hashes: [124] })).status).toBe(200);
  expect(f.live.perks).toMatchObject({ 124: { aliasOf: 123, aliasKind: 'name' } });
  f.moveData({
    [aliasGroupsPath]: groups(124),
    'tooltips/123.json': undefined,
    'tooltips/124.json': document(124),
  });
  expect((await f.request('/push-live', 'POST', { hashes: [125] })).status).toBe(200);
  expect(f.live.perks).toMatchObject({ 123: { aliasOf: 124 }, 125: { aliasOf: 124 } });
  f.moveData({
    [aliasGroupsPath]: emptyAliasGroups(),
    'tooltips/123.json': document(123, 'Restored'),
  });
  expect((await f.request('/push-live', 'POST', { hashes: [123] })).status).toBe(200);
  expect(f.live.perks).not.toHaveProperty('125');
  expect(f.live.perks).toMatchObject({
    123: { editor: { en: { main: 'Restored' } } },
    124: { hash: 124 },
  });
});

it('rejects a push retry when the reviewed group changes at a data-head race', async () => {
  publisherConfig.enabled = false;
  const expected = await publishableHash(document(123), aliases());
  f.beforeLive = () => f.moveData({ [aliasGroupsPath]: groups(123, [123, 124]) });
  const response = await f.request('/push-live', 'POST', {
    hashes: [124],
    expected: { 123: expected },
  });
  expect(response.status).toBe(409);
  expect(f.writes).toHaveLength(0);
});

it('refuses batch save, rebase, and scheduling for a newly grouped member', async () => {
  batch();
  const response = await f.request(`/batches/${BATCH}/save`, 'POST', {
    revision: 1,
    changes: [{ hash: 124, base: document(124), next: document(124, 'Edited') }],
    message: 'Edit',
  });
  expect(response.status).toBe(422);
  expect(
    (
      await f.request(`/batches/${BATCH}/rebase`, 'POST', {
        revision: 1,
        hash: 124,
        base: null,
        next: document(124),
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await f.request(`/batches/${BATCH}/schedule`, 'POST', {
        revision: 1,
        notBefore: 'now',
        zone: 'UTC',
      })
    ).status,
  ).toBe(422);
  expect(f.current()['tooltips/124.json']).toBeUndefined();
});

it.each([false, true])(
  'refuses activation-conflict resolution that would recreate an archived alias tooltip (race=%s)',
  async (race) => {
    batch();
    const path = schedulePaths.batch(BATCH);
    const existing = f.current()[path] as object;
    const stamp = '2026-11-01T00:00:00Z';
    f.moveData({
      [path]: {
        ...existing,
        status: 'published',
        opId: OP,
        notBefore: '2026-11-01T00:00:00.000Z',
        zone: 'UTC',
        scheduledContentRevision: 1,
        claim: { opId: OP, claimedAt: stamp },
        result: {
          opId: OP,
          status: 'published',
          landedAt: stamp,
          landedAtSource: 'cas',
          recordedAt: stamp,
          exportNow: stamp,
          liveCommit: sha(2),
        },
      },
      [schedulePaths.conflict(124)]: {
        hash: 124,
        batchId: BATCH,
        opId: OP,
        fields: ['$exists'],
        changed: ['text.en'],
        base: document(124),
        proposed: document(124, 'Upcoming text'),
        currentAtRecord: null,
      },
    });
    if (race) {
      f.moveData({ [aliasGroupsPath]: undefined });
      f.beforePatch = () => f.moveData({ [aliasGroupsPath]: groups() });
    }
    const response = await f.request(`/batches/${BATCH}/resolve`, 'POST', {
      hash: 124,
      expectedCurrent: null,
      choices: { $exists: 'upcoming' },
    });
    expect(response.status, await response.clone().text()).toBe(422);
    expect(f.current()['tooltips/124.json']).toBeUndefined();
  },
);
