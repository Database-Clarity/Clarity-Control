import { expect, it } from 'vitest';
import { compendiumDataSchema, resolveCompendiumLink, sameCell } from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions } from './guidedDecisions';
import { loadManifestFacts } from './manifestFacts';
import { notCurrentArtifact } from './artifactIdentity';
import { classifyScope, inScopeCategory } from './reviewScope';
import { sharedPerkLabel } from '../navigation/catalog';
import frozen from './fixtures/frozen-matcher.json';

function fixture(hash = 2903198437, name = 'Armorsmith') {
  const f = guidedFixture(),
    category = f.categories[0];
  const record = f.document.categories[category.id];
  category.id = record.id = 'catalog:armor-mod-seasonal';
  const facts = loadManifestFacts();
  const entry = {
    ...category.entries[2],
    hash,
    name,
    manifestFacts: { item: facts.items[hash], version: facts.source.manifestVersion },
  };
  category.entries = [entry];
  record.hashes = [hash];
  record.references = {};
  f.source = compendiumDataSchema.parse({ ...f.source, tabs: [frozen.artifactSource] });
  const decide = () =>
    guidedDecisions(f.document, [category], new Map(), f.source, f.baseline, f.scope)[0];
  return { ...f, category, entry, decide };
}
it('links Armorsmith under BOTH current artifacts with stable multipart headings and styled descriptions', () => {
  const f = fixture(),
    group = f.decide(),
    decision = group.entries[0];
  expect(decision).toMatchObject({
    action: 'link',
    confidence: 'high',
    link: {
      parts: ['Encrypted Data Disk (Renegades)', 'Queensfoil Censer (Wish)'],
    },
  });
  expect(group.unresolved).toBe(0);
  const resolved = resolveCompendiumLink(decision.link!, f.source);
  expect(resolved.status).toBe('ok');
  if (!('row' in resolved)) throw new Error('Missing multipart source');
  expect(sameCell(resolved.row.cell, decision.link!.snapshot)).toBe(true);
  const rows = f.source.tabs[0].rows.filter((r) => r.name === 'Armorsmith');
  for (const row of rows) expect(decision.link!.snapshot.plain).toContain(row.cell.plain);
  expect(decision.link!.snapshot.plain).not.toContain('Kinetic Synthesis\n');
  f.editor.items[f.entry.hash] = {
    hash: f.entry.hash,
    name: f.entry.name,
    categoryId: 'armor-mod-seasonal',
    icon: '',
    inGameDescription: '',
  };
  expect(sharedPerkLabel(f.entry.hash, f.editor, f.source)).toBe(
    'Shared perk — used on: Encrypted Data Disk, Queensfoil Censer',
  );
  // A same-name third card without manifest parent evidence cannot join the link.
  f.source.tabs[0].rows.push({ ...rows[0], rowIndex: 200, section: 'Unknown' });
  expect(f.decide().entries[0].link).toBeUndefined();
});
it('drops the twelve absent plugs without socket parents with the owner-specified reason', () => {
  const hashes = [
    4217417017, 4217417018, 3619040079, 3619040074, 3619040077, 3619040075, 4217417019, 4217417020,
    4217417023, 4217417022, 4217417021, 3619040078,
  ];
  for (const hash of hashes) {
    const facts = loadManifestFacts();
    const f = fixture(hash, facts.items[hash].inventory!.displayName!);
    f.entry.artifactSunset = notCurrentArtifact(f.entry, f.source);
    expect(classifyScope(f.entry, f.category.id)).toBe('artifact-source-absent');
    expect(inScopeCategory(f.category).entries).toHaveLength(0);
    expect(f.decide()).toMatchObject({
      outOfScope: 1,
      unresolved: 0,
      entries: [
        {
          action: 'out-of-scope',
          reason: 'not in a current artifact',
        },
      ],
    });
  }
});

it('preserves the protected Impact, Shock, Gravity owner sample outside the twelve-entry exclusion', () => {
  const f = fixture(3619040072, 'Impact, Shock, Gravity');
  expect(notCurrentArtifact(f.entry, f.source)).toBe(false);
});
