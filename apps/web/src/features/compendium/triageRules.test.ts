import { expect, it } from 'vitest';
import {
  compendiumDataSchema,
  combineCompendiumMatches,
  compendiumDescriptionCells,
  resolveCompendiumLink,
  snapshotCompendium,
  normaliseCompendiumName,
  type CompendiumSheet,
} from '@clarity/core';
import triage from './owner-triage.json';
import fixture from './fixtures/triage.json';
import reviewed from './owner-reviewed.json';
import {
  classifyItem,
  inferItemClassification,
  attachmentCategory,
  effectCategory,
  inactiveCategory,
} from './itemClassification';
import { inferredSiphonDecision } from './safeSourceRules';
import { reviewedOwnerDecision, tentativeOwnerDecision } from './ownerReviewed';
import { loadManifestFacts, type ManifestFacts } from './manifestFacts';
import { guidedFixture } from '../../../test/guided-fixture';
import { proposalFor } from './rapidReview';
import type { EditorData } from '../../stores/data';
import type { ReviewSample } from './reviewCategories';

const facts = loadManifestFacts();
const source = compendiumDataSchema.parse(fixture.source);
const items = fixture.items as unknown as EditorData['items'];
function entry(hash: number): ReviewSample {
  const f = guidedFixture(),
    item = items[hash];
  return {
    ...f.categories[0].entries[2],
    hash,
    name: item.name,
    category: item.categoryId,
    base: { hash, text: {}, associated: [] },
    next: { hash, text: {}, associated: [] },
    manifestFacts: { item: facts.items[hash], version: facts.source.manifestVersion },
    classification: classifyItem(item),
    sampleEvidence: reviewed.noEquivalent.find((r) => r.hash === hash)?.entryEvidence ?? '',
  };
}
it('records all 282 final owner dispositions as positive or negative regression cases', () => {
  expect(triage.members).toHaveLength(282);
  for (const record of triage.members) {
    const item = items[record.hash];
    expect(item?.name).toBe(record.name);
    const c = classifyItem(item);
    if (c) expect(c.ruleId, record.name).toBe(record.ruleId);
    switch (record.disposition) {
      case 'attachment':
        expect(c, record.name).toMatchObject({
          categoryId: attachmentCategory,
          excluded: true,
          origin: 'owner',
        });
        break;
      case 'effect':
      case 'effect-tentative':
        expect(c, record.name).toMatchObject({
          categoryId: effectCategory,
          excluded: false,
          priority: record.disposition === 'effect' ? 'required' : 'tentative',
        });
        break;
      case 'inactive':
        expect(c, record.name).toMatchObject({ categoryId: inactiveCategory, excluded: true });
        break;
      case 'optional':
        expect(c, record.name).toMatchObject({
          priority: 'optional',
          excluded: false,
          ruleId: 'optional-movement',
        });
        break;
      case 'armor-stat':
      case 'weapon-mod-excluded':
      case 'irrelevant':
        expect(c?.excluded, record.name).toBe(true);
        break;
      case 'distinct-artifact':
        expect(c, record.name).toMatchObject({
          ruleId: 'artifact-identity-unresolved',
          excluded: false,
        });
        break;
      case 'siphon':
        expect(inferredSiphonDecision(entry(record.hash), source), record.name).toMatchObject({
          action: 'link',
          link: { gid: '1934379638', section: 'Helmet' },
        });
        break;
      case 'no-equivalent':
        expect(
          tentativeOwnerDecision(entry(record.hash), reviewed.sourceFingerprint),
          record.name,
        ).toBe(true);
        break;
      case 'combined':
        expect(reviewed.verified).toHaveProperty(String(record.hash));
        break;
      default:
        throw new Error(`Uncovered owner disposition: ${record.disposition}`);
    }
  }
  expect(reviewed.noEquivalent).toHaveLength(29);
  for (const hash of triage.unresolved)
    expect(tentativeOwnerDecision(entry(hash), reviewed.sourceFingerprint)).toBe(false);
  expect(tentativeOwnerDecision(entry(2733010662), reviewed.sourceFingerprint)).toBe(false);
  for (const record of triage.legacyNoEquivalent)
    expect(
      classifyItem({ ...items[record.hash], hash: record.hash, name: record.name }),
    ).toBeUndefined();
});
it('validates inferred rules on held-out real definitions not in the 282 construction cases', () => {
  const ownerHashes = new Set(triage.members.map((r) => r.hash));
  for (const hash of fixture.independent) expect(ownerHashes.has(hash)).toBe(false);
  for (const hash of [839105230, 3250034553, 13792278, 106909392, 791862061])
    expect(inferItemClassification(items[hash], facts.items[hash])).toMatchObject({
      categoryId: attachmentCategory,
      excluded: true,
      origin: 'manifest',
    });
  // Ricochet / armour-piercing / high-caliber have effect perks: stats alone cannot exclude them.
  for (const hash of [1885400500, 1968497646, 1561002382])
    expect(inferItemClassification(items[hash], facts.items[hash])).toMatchObject({
      categoryId: effectCategory,
      excluded: false,
    });
  for (const hash of [2846385770, 706527188])
    expect(inferItemClassification(items[hash], facts.items[hash])).toBeUndefined();
  for (const hash of [3832366019, 897335593, 1086997255])
    expect(inferredSiphonDecision(entry(hash), source)?.action).toBe('link');
  // An independent selector is NOT the set's actual effect, even when names match.
  expect(inferItemClassification(items[139044974], facts.items[139044974])).toMatchObject({
    ruleId: 'irrelevant-selector',
    excluded: true,
  });
  const raw = fixture.independentRaw as unknown as Record<
    string,
    { item: EditorData['items'][string]; facts: ManifestFacts['items'][string] }
  >;
  for (const hash of Object.keys(raw)) expect(ownerHashes.has(Number(hash))).toBe(false);
  for (const hash of [311164277, 323635379])
    expect(inferItemClassification(raw[hash].item, raw[hash].facts)).toMatchObject({
      ruleId: 'manifest-armor-stat',
      excluded: true,
    });
  for (const hash of [1254077559, 2535142633])
    expect(inferItemClassification(raw[hash].item, raw[hash].facts)).toMatchObject({
      categoryId: inactiveCategory,
      excluded: true,
    });
  for (const hash of [1980618587, 666522389, 1124184622, 1763607626])
    expect(inferItemClassification(raw[hash].item, raw[hash].facts)).toBeUndefined();
  expect(inferItemClassification(raw[2897206615].item, raw[2897206615].facts)).toMatchObject({
    ruleId: 'irrelevant-extractor',
    excluded: true,
  });
  expect(inferItemClassification(raw[1961918267].item, raw[1961918267].facts)).toBeUndefined();
  expect(inferItemClassification(raw[476961531].item, raw[476961531].facts)).toMatchObject({
    categoryId: effectCategory,
    excluded: false,
  });
  // Explicit Coils source investigations extend only to actual catalog base/enhanced counterparts.
  expect(classifyItem(items[689005463])).toMatchObject({
    ruleId: 'attachment-source-investigation',
  });
  expect(
    classifyItem({ ...items[689005463], hash: 99, enhancedHash: undefined, enhancedHashes: [] }),
  ).toBeUndefined();
  expect(
    classifyItem({ ...items[2467967826], inGameDescription: 'New mechanic description' }),
  ).toMatchObject({ ruleId: 'owner-classification-evidence-changed', excluded: false });
  const conditional = structuredClone(facts.items[839105230]);
  conditional.inventory!.investmentStats![0].isConditionallyActive = true;
  expect(inferItemClassification(items[839105230], conditional)?.excluded).toBe(false);
  const stale = structuredClone(facts.items[839105230]);
  stale.inventory!.description = 'Mechanics changed';
  expect(inferItemClassification(items[839105230], stale)).toBeUndefined();
  const promoted = {
    hash: 839105230,
    text: {},
    associated: [],
    custom: { name: items[839105230].name, categoryId: effectCategory },
  };
  expect(classifyItem(items[839105230], promoted)).toMatchObject({
    categoryId: effectCategory,
    excluded: false,
    origin: 'editor',
  });
});
it('refuses distinct artifact same-name mechanics and ambiguous or mislabelled generic Siphon sources', () => {
  const tab = source.tabs.find((t) => t.gid === '473308249')!;
  const rows = tab.rows.filter((r) => r.name === 'Elemental Siphon');
  expect(rows).toHaveLength(2);
  expect(combineCompendiumMatches(rows.map((row) => ({ tab, row })))).toBeUndefined();
  expect(inferredSiphonDecision(entry(3619040076), source)).toBeUndefined();
  const unsupported = { ...entry(3832366019), name: 'Arc Entropy Siphon' };
  unsupported.manifestFacts = structuredClone(unsupported.manifestFacts)!;
  unsupported.manifestFacts.item.inventory!.displayName = unsupported.name;
  expect(inferredSiphonDecision(unsupported, source)).toBeUndefined();
  const unknown = { ...entry(3832366019), name: 'Health Siphon' };
  expect(inferredSiphonDecision(unknown, source)).toBeUndefined();
  const changed = structuredClone(source),
    helmet = changed.tabs.find((t) => t.gid === '1934379638')!;
  helmet.rows.push({ ...helmet.rows[0], rowIndex: 999 });
  expect(inferredSiphonDecision(entry(2733010662), changed)).toMatchObject({
    action: 'owner',
    reason: expect.stringContaining('ambiguous'),
  });
  helmet.rows.pop();
  helmet.rows[0].cell = {
    plain: 'Unrelated damage buff',
    runs: [{ text: 'Unrelated damage buff' }],
  };
  expect(inferredSiphonDecision(entry(2733010662), changed)?.action).toBe('owner');
});
it('assembles both Micro-Missile cells, labelled Hammer variants with cooldown once, and all of Slicewire', () => {
  const f = guidedFixture();
  f.source = source;
  f.editor.items = items;
  f.editor.bundle.tooltips = fixture.tooltips as unknown as EditorData['bundle']['tooltips'];
  for (const hash of [2928496916, 2747500761, 1377143502]) {
    const proof = (reviewed.verified as Record<string, (typeof reviewed.verified)['1377143502']>)[
      hash
    ];
    const e = {
      ...entry(hash),
      base: f.editor.bundle.tooltips[hash] ?? entry(hash).base,
      sampleEvidence: proof.entryEvidence,
    };
    const decision = reviewedOwnerDecision(e, proposalFor(e.base, f.editor, source), source)!;
    expect(decision.action).toBe('link');
    expect(resolveCompendiumLink(decision.link!, source).status).toBe('ok');
    const moved = structuredClone(source);
    for (const tab of moved.tabs) {
      for (const row of tab.rows) {
        row.rowIndex += 11;
        if (row.anchor) {
          row.anchor.row += 11;
          row.anchor.col += 2;
        }
      }
      for (const cell of tab.grid ?? []) {
        cell.row += 11;
        cell.col += 2;
      }
    }
    const refreshed = { ...e, sampleEvidence: 'fresh layout / edited English evidence' };
    expect(
      reviewedOwnerDecision(refreshed, proposalFor(refreshed.base, f.editor, moved), moved)?.action,
    ).toBe('link');
    expect(
      reviewedOwnerDecision(
        { ...e, name: 'Different item identity' },
        proposalFor(e.base, f.editor, source),
        source,
      )?.action,
    ).toBe('owner');

    const text = decision.link!.snapshot.plain;
    if (hash === 2928496916) {
      expect(text).toContain('Special Grenade Launchers');
      expect(text).toContain('Pulse Rifles and Sidearms');
      expect(text).toContain('+20 Mobility');
      expect(text).toContain('Uses Special Ammo');
      for (const owner of ['Pulse Rifle', 'Grenade Launcher']) {
        f.editor.items[hash] = { ...items[hash], itemName: owner };
        expect(
          reviewedOwnerDecision(e, proposalFor(e.base, f.editor, source), source)?.link?.snapshot
            .plain,
        ).toBe(text);
      }
    } else if (hash === 2747500761) {
      expect(decision.link!.parts).toEqual(['Hammer of Sol', 'Sol Invictus Aspect']);
      expect(text.match(/Base Cooldown:/g)).toHaveLength(1);
      expect(text).toContain('556 seconds');
    } else {
      expect(text).toContain('bouncing grenade');
      expect(text).toContain('Base Cooldown: 219.5 seconds');
      expect(text).toContain('Chunk Scalar: 0.5x');
    }
  }
});
it('recovers compound cells on unseen real abilities, follows layout moves, and does not merge unrelated supers', () => {
  const glacier = source.tabs.find((t) => t.name === 'Stasis')!;
  expect(compendiumDescriptionCells({ tab: glacier, row: glacier.rows[0] })).toHaveLength(2);
  const solar = source.tabs.find((t) => t.name === 'Solar')!;
  const golden = solar.rows.filter((r) => r.name.startsWith('Golden Gun'));
  expect(golden).toHaveLength(2);
  for (const row of golden) expect(compendiumDescriptionCells({ tab: solar, row })).toHaveLength(2);
  expect(combineCompendiumMatches(golden.map((row) => ({ tab: solar, row })))).toBeUndefined();
  // Independent structural example: two labelled Nova Dive variants, one shared cooldown.
  const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
  const cd = 'Base Cooldown: 90 seconds';
  const tab: CompendiumSheet = { gid: '1186062409', name: 'Solar', rows: [], grid: [] };
  for (let i = 0; i < 2; i++) {
    const name = `Nova Dive (${i ? 'Empowered' : 'Normal'})`,
      rowIndex = 300 + i;
    tab.rows.push({
      name,
      nameNorm: normaliseCompendiumName(name),
      rowIndex,
      anchor: { row: rowIndex, col: 1 },
      cell: cell(`Effect ${i}\n${cd}`),
    });
    tab.grid!.push(
      { row: rowIndex, col: 3, cell: cell(`Effect ${i}`) },
      { row: rowIndex, col: 13, cell: cell(cd) },
    );
  }
  const match = combineCompendiumMatches(tab.rows.map((row) => ({ tab, row })))!;
  expect(match.row.cell.plain.match(/Base Cooldown:/g)).toHaveLength(1);
  const data = { fetchedAt: source.fetchedAt, tabs: [tab] },
    link = snapshotCompendium(match, source.fetchedAt);
  for (const row of tab.rows) {
    row.rowIndex += 17;
    row.anchor!.row += 17;
    row.anchor!.col += 2;
  }
  for (const cell of tab.grid!) {
    cell.row += 17;
    cell.col += 2;
  }
  expect(resolveCompendiumLink(link, data).status).toBe('ok');
  tab.grid![3].cell = cell('Base Cooldown: 120 seconds');
  tab.rows[1].cell = cell('Effect 1\nBase Cooldown: 120 seconds');
  expect(
    combineCompendiumMatches(tab.rows.map((row) => ({ tab, row })))!.row.cell.plain.match(
      /Base Cooldown:/g,
    ),
  ).toHaveLength(2);
});

it('groups the crossbow bolts with the other parts that carry an effect', () => {
  for (const hash of [1202133695, 2523856971]) {
    const inv = facts.items[hash].inventory!;
    const item = {
      hash,
      name: inv.displayName,
      icon: '',
      categoryId: 'weapon-perk',
      inGameDescription: inv.description,
    } as EditorData['items'][string];
    expect(inferItemClassification(item, facts.items[hash])).toMatchObject({
      categoryId: effectCategory,
      excluded: false,
    });
  }
});
