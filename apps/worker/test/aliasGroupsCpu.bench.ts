// Local CPU proxy, not deployed Workers CPU. Supply the four generator JSON files from ONE
// immutable revision in ALIAS_DATA. Run separately with a config including this file.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  aliasGroupsPath,
  composeAliases,
  emptyAliasGroups,
  incomingAliases,
  publishableHash,
  resolveAlias,
  type AliasGroups,
  type AliasItems,
  type Aliases,
  type SandboxConflicts,
} from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { signToken } from '../src/crypto.js';
import worker from '../src/index.js';
import { Fixture, makePrivateKey, sha, tooltip } from './fixture.js';
import { scopedAliases } from '../src/catalog.js';

it('measures cold and warm grouped save, publish, and rollback push on real generator inputs', async () => {
  const dir = process.env.ALIAS_DATA!;
  const files = new Map(
    ['items.json', 'categories.json', 'aliases.json', 'sandboxConflicts.json'].map((file) => [
      file,
      readFileSync(join(dir, file), 'utf8'),
    ]),
  );
  const items = JSON.parse(files.get('items.json')!) as AliasItems;
  const generated = JSON.parse(files.get('aliases.json')!) as Aliases;
  const conflicts = JSON.parse(files.get('sandboxConflicts.json')!) as SandboxConflicts;
  // Find a real eligible group, rather than inventing identities at real-sized cardinalities.
  const candidates = new Map<string, number[]>();
  for (const item of Object.values(items)) {
    if (
      generated[item.hash] ||
      conflicts[item.hash] ||
      item.isEnhanced ||
      item.exotic ||
      item.baseHash !== undefined ||
      item.owners ||
      item.itemHash !== undefined ||
      item.categoryId !== 'weapon-trait' ||
      item.plugCategoryHash === undefined
    )
      continue;
    const key = JSON.stringify([item.name, item.categoryId, item.plugCategoryHash]);
    candidates.set(key, [...(candidates.get(key) ?? []), item.hash]);
  }
  const members = [...candidates.values()]
    .filter((value) => value.length > 1)
    .sort((a, b) => b.length - a.length)[0];
  expect(members).toBeDefined();
  const hash = members![0]!;
  const item = items[hash]!;
  const group: AliasGroups = {
    ...emptyAliasGroups(),
    groups: {
      [hash]: {
        members: members!,
        kind: 'S',
        basis: { name: item.name, categoryId: item.categoryId },
        by: { id: '1', login: 'alice' },
        at: '2025-01-01T00:00:00Z',
      },
    },
  };
  const effective = composeAliases(generated, group, items, conflicts);
  expect(effective.issues).toEqual([]);
  const largest = Object.values(items)
    .filter(
      (item) =>
        item.categoryId !== 'armor-set-bonus' &&
        items[resolveAlias(item.hash, generated)] &&
        items[resolveAlias(item.hash, generated)]!.categoryId !== 'armor-set-bonus',
    )
    .map((item) => item.hash);
  const f = new Fixture(await makePrivateKey());
  const liveBase = structuredClone(f.live);
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const opId = '01K95H00000000000000000001';
  const now = [...opId.slice(0, 10)].reduce(
    (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
    0,
  );
  vi.useFakeTimers({ toFake: ['Date'], now });
  const base = {
    ...tooltip('Canonical benchmark text'),
    hash,
    text: {
      en: {
        text: 'Canonical benchmark text',
        updatedAt: '2025-01-01T00:00:00Z',
        updatedBy: 'alice',
      },
    },
  };
  const token = await signToken(
    { id: 1, login: 'alice', purpose: 'session', exp: Math.floor(now / 1000) + 3600 },
    f.env.SESSION_SECRET,
  );
  const original = globalThis.fetch;
  let mockCpu = 0;
  let requests = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    requests++;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.includes('/generator/commits/'))
        return Response.json({ sha: 'a'.repeat(40) });
      if (url.hostname === 'raw.githubusercontent.com') {
        const text = files.get(url.pathname.split('/').at(-1)!);
        if (text) return new Response(text, { headers: { 'Content-Type': 'application/json' } });
      }
      return await original(input, init);
    } finally {
      mockCpu += performance.now() - start;
    }
  });
  const results: Record<string, unknown> = {
    items: Object.keys(items).length,
    generatedAliases: Object.keys(generated).length,
    conflicts: Object.keys(conflicts).length,
    groupMembers: members,
    note: 'Node CPU proxy; immediate I/O with fixture time subtracted',
  };
  try {
    for (const mode of ['absent', 'accepted'] as const)
      for (const route of ['save', 'publish', 'push-live', 'push-largest'] as const) {
        const expected = await publishableHash(
          base,
          mode === 'accepted' ? effective.aliases : generated,
        );
        const samples: number[] = [];
        const counts: number[] = [];
        for (let i = 0; i < 11; i++) {
          publisherConfig.enabled = route === 'save' || route === 'publish';
          f.live = structuredClone(liveBase);
          f.liveHead = sha(f.sequence++);
          f.liveFileSha = sha(f.sequence++);
          f.largeFile = route === 'push-largest';
          const path = route === 'push-largest' ? 'push-live' : route;
          const largeFiles =
            route === 'push-largest'
              ? Object.fromEntries(
                  largest.map((hash) => [
                    `tooltips/${resolveAlias(hash, generated)}.json`,
                    { ...base, hash: resolveAlias(hash, generated) },
                  ]),
                )
              : {};
          f.moveData({
            ...largeFiles,
            'live/pushed.json': {},
            [aliasGroupsPath]: mode === 'accepted' ? group : undefined,
            [`tooltips/${hash}.json`]: base,
            '.publisher/PIN': { capabilities: ['aliasGroups', 'sandboxPointers'] },
            [`publish/requests/${opId}.json`]: undefined,
          });
          const value =
            route === 'save'
              ? { message: 'Benchmark', changes: [{ hash, base, next: base }] }
              : route === 'publish'
                ? { opId, hashes: [hash], expected: { [hash]: expected } }
                : route === 'push-largest'
                  ? { hashes: largest }
                  : { hashes: [hash], expected: { [hash]: expected } };
          const request = new Request(`https://api.example/${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Origin: f.env.SITE_ORIGIN },
            body: JSON.stringify(value),
          });
          mockCpu = 0;
          requests = 0;
          const start = performance.now();
          const response = await worker.fetch(request, f.env, { waitUntil() {} });
          const text = await response.text();
          samples.push(performance.now() - start - mockCpu);
          counts.push(requests);
          expect(response.status, text).toBe(route === 'publish' ? 202 : 200);
          expect(requests).toBeLessThanOrEqual(48);
        }
        const warm = samples.slice(1).sort((a, b) => a - b);
        results[`${mode}/${route}`] = {
          coldMs: samples[0],
          warmMedianMs: warm[5],
          warmMaxMs: warm.at(-1),
          subrequests: counts,
          requestedRows: route === 'push-largest' ? largest.length : 1,
        };
      }
    console.log(`ALIAS_CPU ${JSON.stringify(results)}`);
    if (process.env.ALIAS_CPU_OUT)
      writeFileSync(process.env.ALIAS_CPU_OUT, JSON.stringify(results, null, 2));
  } finally {
    publisherConfig.enabled = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it(
  'matches full S1 composition for EVERY real generator identity and incoming stub',
  { timeout: 120_000 },
  () => {
    const read = (file: string) =>
      JSON.parse(readFileSync(join(process.env.ALIAS_DATA!, file), 'utf8'));
    const items = read('items.json') as AliasItems;
    const aliases = read('aliases.json') as Aliases;
    const conflicts = read('sandboxConflicts.json') as SandboxConflicts;
    const members = [1168162263, 1528281896, 3124871000];
    const item = items[members[0]!]!;
    const groups: AliasGroups = {
      ...emptyAliasGroups(),
      groups: {
        [item.hash]: {
          members,
          kind: 'S',
          basis: { name: item.name, categoryId: item.categoryId },
          by: { id: '1', login: 'alice' },
          at: '2025-01-01T00:00:00Z',
        },
      },
    };
    const full = composeAliases(aliases, groups, items, conflicts).aliases;
    const hashes = new Set(
      [
        ...Object.keys(items),
        ...Object.keys(aliases),
        ...Object.values(aliases).map((alias) => String(alias.to)),
      ].map(Number),
    );
    let maxAliases = 0;
    for (const hash of hashes) {
      const scope = scopedAliases({ items, aliases, conflicts, categories: [] }, groups, null);
      const selected = scope.extend([hash]);
      const canonical = resolveAlias(hash, full);
      expect(resolveAlias(hash, selected), `canonical ${hash}`).toBe(canonical);
      expect(incomingAliases(canonical, selected), `incoming ${hash}`).toEqual(
        incomingAliases(canonical, full),
      );
      maxAliases = Math.max(maxAliases, Object.keys(selected).length);
    }
    if (process.env.ALIAS_CORPUS_OUT)
      writeFileSync(
        process.env.ALIAS_CORPUS_OUT,
        JSON.stringify({
          identities: hashes.size,
          items: Object.keys(items).length,
          aliases: Object.keys(aliases).length,
          groupMembers: members,
          maxScopedAliases: maxAliases,
        }),
      );
  },
);
