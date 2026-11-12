import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { exportLegacy } from '../src/exportLegacy.js';
import { migrateLegacy } from '../src/migrateLegacy.js';
import { stableStringify } from '../src/contentHash.js';
import type { LegacyCatalog, LegacyPerk } from '../src/legacy.js';
import { database, fixture } from './helpers.js';

function catalog(perks: Record<string, LegacyPerk>): LegacyCatalog {
  return Object.fromEntries(Object.entries(perks).map(([hash, perk]) => [hash, {
    name: perk.name, type: perk.type,
    ...(perk.itemHash !== undefined ? { itemHash: perk.itemHash } : {}),
    ...(perk.itemName !== undefined ? { itemName: perk.itemName } : {}),
  }]));
}
function withoutDroppedFields(perks: Record<string, LegacyPerk>) {
  const normalized = structuredClone(perks);
  for (const perk of Object.values(normalized)) {
    delete perk.stats;
    delete perk.importStatsFrom;
    delete perk.duration;
    delete perk.activationCondition;
    if (perk.updateTracker) delete perk.updateTracker.stats;
    for (const text of Object.values(perk.editor)) {
      if (text) text.secondary = text.main;
    }
  }
  return normalized;
}
// Derive the allowed omissions from the immutable source, independently of the exporter.
function textlessHashes(perks: Record<string, LegacyPerk>) {
  return Object.values(perks)
    .filter((perk) => perk.hash > 3 && !Object.values(perk.editor).some((text) => text?.main.trim()))
    .map((perk) => perk.hash);
}
function withoutTextless(perks: Record<string, LegacyPerk>) {
  const omitted = new Set(textlessHashes(perks));
  return Object.fromEntries(Object.entries(perks).filter(([hash]) => !omitted.has(Number(hash))));
}
test.each([
  ['live', 984, '555b3d15c836630fcc93c1b858be72f79a7807d340fbb976d56e2d0002cd95c7'],
  ['intermediate', 982, '8ae726cb36bdbfd044a0a3e5e1b19f06b677589f5a4ab86945f92954b5e1724b'],
] as const)('%s omits exactly the recorded text-less source hashes', (name, count, digest) => {
  const omitted = textlessHashes(database(name).perks);
  expect(omitted).toHaveLength(count);
  expect(createHash('sha256').update(JSON.stringify(omitted)).digest('hex')).toBe(digest);
});
test('every written live hash roundtrips except intentional secondary replacement and stat removal', () => {
  const live = database('live');
  expect(exportLegacy(migrateLegacy(live), 0, catalog(live.perks))).toEqual(
    withoutTextless(withoutDroppedFields(live.perks)),
  );
});
test('every intermediate field survives independently of the documented live-branch drift', () => {
  const intermediate = database('intermediate');
  const live = database('live');
  const exported = exportLegacy(migrateLegacy(intermediate), 0, catalog(intermediate.perks));
  const expectedIntermediate = withoutDroppedFields(intermediate.perks);
  const expectedLive = withoutDroppedFields(live.perks);
  expect(exported).toEqual(withoutTextless(expectedIntermediate));
  // Drift includes two records written on only one branch. Keep the complete source
  // comparison, even when one side is intentionally omitted from consumer inputs.
  expect(Object.keys(expectedIntermediate).sort()).toEqual(Object.keys(expectedLive).sort());
  const authoredFields = ['editor'] as const;
  const differences = [];
  for (const hash of Object.keys(expectedLive)) {
    const source = expectedIntermediate[hash];
    const target = expectedLive[hash];
    const fields = authoredFields.filter((field) =>
      stableStringify({ value: source[field] }) !== stableStringify({ value: target[field] }),
    );
    if (fields.length === 0) continue;
    const select = (perk: LegacyPerk) =>
      Object.fromEntries(fields.map((field) => [field, perk[field] ?? null]));
    differences.push({
      hash: Number(hash),
      reason: `Existing source-branch differences in ${fields.join(', ')}; preserve intermediate authored values.`,
      intermediate: select(source),
      live: select(target),
    });
  }
  expect(differences).toEqual(fixture('branch-drift'));
});
test('generator confirms exactly four non-manifest tooltips and English-only stored content', () => {
  const generator = fixture('generator') as { perks: Record<string, unknown> };
  const intermediate = database('intermediate');
  expect(Object.keys(intermediate.perks).filter((hash) => !generator.perks[hash])).toEqual(['0', '1', '2', '3']);
  expect([...new Set(Object.values(intermediate.perks).flatMap((perk) => Object.keys(perk.editor)))]).toEqual(['en']);
  expect([...new Set(Object.values(generator.perks).flatMap((perk) =>
    Object.keys(perk as Record<string, unknown>),
  ))].sort()).toEqual(['hash', 'itemHash', 'itemName', 'name', 'type']);
});
test('downloaded fixtures match their recorded checksums and immutable source commits', () => {
  const provenance = fixture('provenance') as {
    sources: Record<string, { bytes: number; sha256: string; commit: string; url: string }>;
  };
  expect(Object.keys(provenance.sources).sort()).toEqual(['generator', 'intermediate', 'live']);
  for (const [name, source] of Object.entries(provenance.sources)) {
    const bytes = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url));
    expect(bytes.length).toBe(source.bytes);
    expect(source.bytes).toBeLessThanOrEqual(5_000_000);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(source.url).toContain(`/${source.commit}/`);
  }
});
