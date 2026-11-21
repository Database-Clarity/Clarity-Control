import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions, guidedRevision } from './guidedDecisions';
import { proposalFor } from './rapidReview';
import { loadManifestFacts } from './manifestFacts';
import { emptyProgress } from './reviewProgress';
import { reviewCategories } from './reviewCategories';
import { reviewQueue } from './reviewQueue';

it('learns a tab from a sample whose source cells changed, but not from changed owner evidence', () => {
  const f = guidedFixture();
  const record = f.document.categories[f.categories[0].id];
  const fingerprint = sourceFingerprint(f.source.tabs);
  const categories = () =>
    reviewCategories(
      reviewQueue(f.editor, f.source, {}, emptyProgress(), fingerprint),
      f.editor,
      f.proposals,
      false,
    );
  // Owner text exists before the sample is recorded, so rewriting it is a real change.
  f.editor.bundle.tooltips[100] = {
    hash: 100,
    text: { en: { text: 'Mechanics 0', updatedAt: '2026-11-01T00:00:00Z' } },
    associated: [],
  } as never;
  const entry = (hash: number) =>
    categories()
      .flatMap((group) => group.entries)
      .find((entry) => entry.hash === hash)!;
  record.references = {
    100: sampleReference(entry(100), record.id, `synthetic|${fingerprint}`, '', 'accepted', {
      tab: f.source.tabs[0],
      row: f.source.tabs[0].rows[0],
    }, f.source),
  };
  const decide = (hash: number) =>
    guidedDecisions(
      f.document,
      categories(),
      f.proposals,
      f.source,
      `synthetic|${fingerprint}`,
      f.scope,
    )
      .flatMap((group) => group.entries)
      .find((entry) => entry.hash === hash);
  expect(decide(102)).toMatchObject({ action: 'link', confidence: 'high' });
  // A real source edit withdraws that sample's link but still demonstrates its tab.
  f.source.tabs[0].rows[0].cell = { plain: 'Mechanics 0 now', runs: [{ text: 'Mechanics 0 now' }] };
  expect(decide(100)).toMatchObject({ action: 'owner' });
  expect(decide(102)).toMatchObject({
    action: 'link',
    confidence: 'high',
    ruleId: 'unique-name-in-learned-tab',
  });
  const sample = record.references[100];
  record.references[100] = { ...sample, sourceHash: 'invalid' };
  expect(decide(102)).toMatchObject({ action: 'owner' });
  record.references[100] = sample;
  // The owner's own text changed: the sample no longer says where its sources live.
  const owner = f.editor.bundle.tooltips[100];
  f.editor.bundle.tooltips[100] = {
    hash: 100,
    text: { en: { text: 'Rewritten owner text', updatedAt: '2026-11-02T00:00:00Z' } },
    associated: [],
  } as never;
  expect(decide(102)).toMatchObject({ action: 'owner' });
  f.editor.bundle.tooltips[100] = owner;
  const [moved] = f.source.tabs[0].rows.splice(0, 1);
  f.source.tabs.push({ gid: 'another-tab', name: 'Other', rows: [moved] });
  expect(decide(102)).toMatchObject({ action: 'owner' });
});

it('links a repeated artifact perk to every current section, even with differing cells and parents', () => {
  const f = guidedFixture(),
    category = f.categories[0],
    record = f.document.categories[category.id];
  delete f.document.categories[category.id];
  category.id = record.id = 'catalog:armor-mod-seasonal';
  f.document.categories[record.id] = record;
  const entry = category.entries[2];
  entry.name = 'Armorsmith';
  const facts = loadManifestFacts();
  entry.manifestFacts = { item: facts.items['2903198437'], version: facts.source.manifestVersion };
  const tab = f.source.tabs[0];
  tab.gid = '473308249';
  tab.name = 'Artifact Perks';
  tab.grid = [
    {
      row: 1,
      col: 3,
      cell: { plain: 'Other Artifact (Other)', runs: [{ text: 'Other Artifact (Other)' }] },
    },
    {
      row: 20,
      col: 3,
      cell: {
        plain: 'Encrypted Data Disk (Reclamation)',
        runs: [{ text: 'Encrypted Data Disk (Reclamation)' }],
      },
    },
  ];
  tab.rows = [
    { ...tab.rows[0], rowIndex: 10, name: 'Armorsmith', nameNorm: 'armorsmith', section: 'Other' },
    {
      ...tab.rows[1],
      rowIndex: 30,
      name: 'Armorsmith',
      nameNorm: 'armorsmith',
      section: 'Reclamation',
    },
  ];
  tab.rows[0].anchor = { row: 10, col: 2 };
  tab.rows[1].anchor = { row: 30, col: 2 };
  // Owner 2026-11-21: both sections are sources, exactly as the sheet lists them.
  const parts = ['Other Artifact (Other)', 'Encrypted Data Disk (Reclamation)'];
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
      .entries[2];
  // The fixture cells differ (`Mechanics 0` / `Mechanics 1`); the names still link both.
  expect(decide()).toMatchObject({
    action: 'link',
    confidence: 'high',
    ruleId: 'artifact-manifest-section',
    link: { parts },
  });
  // Socket parents no longer choose a single section, and the old preview family is ignored.
  entry.manifestFacts.item.artifactMemberships = [
    { source: 'socket', artifactHash: 1, artifactName: 'Other Artifact', ownerHash: 2 },
  ];
  expect(decide()).toMatchObject({ action: 'link', link: { parts } });
  // Sunset exclusions stay: a proven parent absent from every current section is excluded.
  entry.manifestFacts.item.artifactMemberships[0].artifactName = 'Sunset Artifact';
  expect(decide()).toMatchObject({ action: 'out-of-scope', ruleId: 'artifact-sunset' });
});

it('links a repeated artifact perk whose triage sample was only skipped', () => {
  const f = guidedFixture(),
    category = f.categories[0],
    record = f.document.categories[category.id];
  delete f.document.categories[category.id];
  category.id = record.id = 'catalog:armor-mod-seasonal';
  f.document.categories[record.id] = record;
  const tab = f.source.tabs[0];
  tab.gid = '473308249';
  tab.name = 'Artifact Perks';
  tab.grid = [
    { row: 1, col: 3, cell: { plain: 'First Artifact (One)', runs: [{ text: 'First Artifact (One)' }] } },
    { row: 20, col: 3, cell: { plain: 'Second Artifact (Two)', runs: [{ text: 'Second Artifact (Two)' }] } },
  ];
  tab.rows = [
    { ...tab.rows[0], rowIndex: 10, name: 'Sample 104', nameNorm: 'sample 104', section: 'One' },
    { ...tab.rows[1], rowIndex: 30, name: 'Sample 104', nameNorm: 'sample 104', section: 'Two' },
  ];
  tab.rows[0].anchor = { row: 10, col: 2 };
  tab.rows[1].anchor = { row: 30, col: 2 };
  const entry = category.entries.find((candidate) => candidate.hash === 104)!;
  // A skipped sample leaves the entry open; it is not an owner no-equivalent decision.
  expect(record.references?.[104]).toMatchObject({ decision: 'skipped' });
  entry.classification = {
    categoryId: 'armor-mod-seasonal',
    ruleId: 'artifact-identity-unresolved',
    reason: 'Recorded distinct mechanics.',
    excluded: false,
    origin: 'owner',
  };
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries.find((decision) => decision.hash === 104)).toMatchObject({
    action: 'link',
    confidence: 'high',
    ruleId: 'artifact-manifest-section',
    link: { parts: ['First Artifact (One)', 'Second Artifact (Two)'] },
  });
});

function artifactTwinFixture(name: string, hash = 102) {
  const f = guidedFixture();
  const category = f.categories[0];
  const record = f.document.categories[category.id];
  delete f.document.categories[category.id];
  category.id = record.id = 'catalog:armor-mod-seasonal';
  f.document.categories[record.id] = record;
  const tab = f.source.tabs[0];
  tab.gid = '473308249';
  tab.name = 'Artifact Perks';
  const heading = (row: number, plain: string) => ({
    row,
    col: 3,
    cell: { plain, runs: [{ text: plain }] },
  });
  tab.grid = [heading(1, 'First Artifact (One)'), heading(20, 'Second Artifact (Two)')];
  const nameNorm = name.toLowerCase();
  tab.rows = [
    {
      ...tab.rows[0],
      rowIndex: 10,
      name,
      nameNorm,
      section: 'One',
      anchor: { row: 10, col: 2 },
    },
    {
      ...tab.rows[1],
      rowIndex: 30,
      name,
      nameNorm,
      section: 'Two',
      anchor: { row: 30, col: 2 },
    },
  ];
  const entry = category.entries.find((candidate) => candidate.hash === hash)!;
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
      .entries.find((decision) => decision.hash === hash);
  return { ...f, category, record, tab, entry, decide };
}

it('keeps manifest-backed identity for a single artifact row', () => {
  const f = artifactTwinFixture('Armorsmith');
  const facts = loadManifestFacts();
  f.entry.name = 'Armorsmith';
  f.entry.manifestFacts = { item: facts.items['2903198437'], version: facts.source.manifestVersion };
  // One same-name row exists in First Artifact, but the socket parent is Second Artifact.
  f.tab.rows = [f.tab.rows[0]];
  f.entry.manifestFacts.item.artifactMemberships = [
    { source: 'socket', artifactHash: 1, artifactName: 'Second Artifact', ownerHash: 2 },
  ];
  expect(f.decide()).toMatchObject({
    action: 'owner',
    confidence: 'unresolved',
    ruleId: 'owner-artifact-identity',
  });
  expect(f.decide().link).toBeUndefined();
});

it('keeps note-only samples and category comments on artifact twins', () => {
  const note = artifactTwinFixture('Sample 105', 105);
  // A note-only sample is not the skipped exception.
  expect(note.record.references?.[105]?.decision).toBeUndefined();
  expect(note.decide()).toMatchObject({ action: 'owner', confidence: 'unresolved' });
  expect(note.decide().link).toBeUndefined();
  const comment = artifactTwinFixture('Sample 102', 102);
  comment.record.comment = 'Owner wants these reviewed together.';
  expect(comment.decide()).toMatchObject({
    action: 'owner',
    confidence: 'unresolved',
    reason: expect.stringContaining('comment'),
  });
  expect(comment.decide().link).toBeUndefined();
});

it('requires catalog parent and perk identity on the exotic card', () => {
  const f = guidedFixture();
  const category = f.categories[0];
  const record = f.document.categories[category.id];
  delete f.document.categories[category.id];
  category.id = record.id = 'catalog:weapon-frame-exotic';
  f.document.categories[record.id] = record;
  const entry = category.entries[2];
  entry.name = 'Cranial Spike II';
  entry.exoticParentNames = ["Dead Man's Tale", 'Another exotic'];
  const tab = f.source.tabs[0];
  tab.name = 'Exotic Weapons';
  tab.rows[2].name = "Dead Man's Tale\nCranial Spike I–IV";
  tab.rows[2].nameNorm = 'dead man s tale cranial spike i iv';
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
      .entries[2];
  expect(decide()).toMatchObject({ action: 'link', ruleId: 'exotic-catalog-parent' });
  tab.rows[0].name = 'Another exotic';
  f.proposals.set(entry.hash, { match: { tab, row: tab.rows[2] }, candidates: [] });
  expect(decide()).toMatchObject({ action: 'link', ruleId: 'exotic-catalog-parent' });
  f.proposals.delete(entry.hash);
  expect(decide().ruleId).not.toBe('exotic-catalog-parent');
  entry.exoticParentNames = [];
  entry.name = 'Default Ornament';
  expect(decide().ruleId).not.toBe('exotic-catalog-parent');
});

it('uses core armor variants while protecting multipart and owner samples', () => {
  for (const [name, row, gid] of [['Harmonic Dexterity', 'Dexterity', '1934379638']]) {
    const f = guidedFixture();
    const category = f.categories[0];
    const record = f.document.categories[category.id];
    delete f.document.categories[category.id];
    category.id = record.id = 'catalog:armor-mod-general';
    f.document.categories[record.id] = record;
    const entry = category.entries[2];
    entry.name = name;
    f.editor.items[entry.hash].name = name;
    f.editor.items[entry.hash].categoryId = 'armor-mod-general';
    f.source.tabs[0].gid = gid;
    f.source.tabs[0].name = gid === '1287885342' ? 'Armor Perks' : 'Armor Mods';
    f.source.tabs[0].rows[2].name = row;
    f.source.tabs[0].rows[2].nameNorm = row.toLowerCase();
    f.proposals.set(entry.hash, proposalFor(entry.base, f.editor, f.source));
    const decide = () =>
      guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
        .entries[2];
    expect(decide()).toMatchObject({ action: 'link', ruleId: 'armor-core-variant' });
    record.references![entry.hash] = { ...record.references![104], hash: entry.hash };
    expect(decide().action).toBe('owner');
  }
});

it('offers a close typo only for confirmation and preserves owner samples', () => {
  const f = guidedFixture();
  const entry = f.categories[0].entries.find((item) => item.hash === 102)!;
  entry.name = 'Precise Jolts';
  const row = f.source.tabs[0].rows[2];
  row.name = 'Precise Jolt';
  row.nameNorm = 'precise jolt';
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
      .entries[2];
  expect(decide()).toMatchObject({ action: 'link', confidence: 'medium' });
  f.document.categories[f.categories[0].id].references![102] = {
    ...f.document.categories[f.categories[0].id].references![104],
    hash: 102,
  };
  expect(decide()).toMatchObject({ action: 'owner', confidence: 'unresolved' });
});

it('proposes exact validated links with two references, exposes complete evidence, and never mutates inputs', () => {
  const f = guidedFixture();
  const before = JSON.stringify([f.document, f.categories, [...f.proposals], f.source]);
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.high).toBe(4);
  expect(group.unresolved).toBe(2);
  expect(group.entries.find((entry) => entry.hash === 102)).toMatchObject({
    action: 'link',
    confidence: 'high',
    references: [100, 101],
    link: { rowKey: 'Sample 102' },
  });
  expect(group.entries.find((entry) => entry.hash === 104)?.action).toBe('owner');
  expect(group.samples).toContain(103);
  expect(before).toBe(JSON.stringify([f.document, f.categories, [...f.proposals], f.source]));
  expect(guidedRevision([group])).toBe(
    guidedRevision(
      guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope),
    ),
  );
});

it('withholds changed baseline, scope and individual source/entry evidence', () => {
  for (const change of ['baseline', 'scope', 'source', 'entry'] as const) {
    const f = guidedFixture();
    if (change === 'baseline') f.baseline += 'changed';
    if (change === 'scope') f.scope += 'changed';
    if (change === 'source')
      f.source.tabs[0].rows[0].cell = { plain: 'Changed', runs: [{ text: 'Changed' }] };
    if (change === 'entry') f.categories[0].entries[0].sampleEvidence += 'changed';
    const [group] = guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    );
    expect(group.issues.length).toBeGreaterThan(0);
    expect(group.entries[0].confidence).toBe('unresolved');
    expect(group.entries[2].confidence).toBe(
      change === 'baseline' || change === 'scope' ? 'unresolved' : 'high',
    );
  }
});

it('learns from one positive reference, requires review for cell conventions, and protects owner samples/comments', () => {
  for (const kind of ['none', 'skip', 'note', 'comment', 'rename', 'cells'] as const) {
    const f = guidedFixture();
    const record = f.document.categories[f.categories[0].id];
    const reference = record.references![100];
    if (kind === 'none' || kind === 'skip' || kind === 'note') {
      reference.decision =
        kind === 'none' ? 'no-equivalent' : kind === 'skip' ? 'skipped' : undefined;
      delete reference.link;
    }
    if (kind === 'comment') record.comment = 'Need manual interpretation';
    if (kind === 'rename') reference.sourceName = 'Different name';
    if (kind === 'cells') reference.link!.cells = [{ dRow: 0, dCol: 2 }];
    const [group] = guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    );
    expect(group.entries[2].confidence).toBe(kind === 'comment' ? 'unresolved' : 'high');
    if (kind === 'skip' || kind === 'note') expect(group.entries[0].action).toBe('owner');
  }
});

it('preserves human overrides and excludes new membership; missing references are explicit', () => {
  const f = guidedFixture();
  f.categories[0].entries[2].status = 'no-equivalent';
  f.document.categories[f.categories[0].id].hashes = [100, 101, 102, 999];
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries.map((entry) => entry.hash)).toEqual([100, 101, 102, 999]);
  expect(group.entries[2].action).toBe('preserve');
  expect(group.entries[3].reason).toContain('missing');
  expect(group.issues.some((issue) => issue.includes('new entries excluded'))).toBe(true);
  f.categories[0].entries = [];
  expect(
    guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    )[0].issues.join(),
  ).toContain('Reference 100');
});

it('withholds fuzzy proposals from high-confidence decisions', () => {
  const f = guidedFixture();
  f.proposals.get(102)!.link = undefined;
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[2].confidence).toBe('high');
});

it('one positive sample establishes a tab; negative samples never establish an absence rule', () => {
  const f = guidedFixture();
  const record = f.document.categories[f.categories[0].id];
  delete record.references![101];
  let [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[2]).toMatchObject({
    confidence: 'high',
    references: [100],
    ruleId: 'unique-name-in-learned-tab',
  });
  delete record.references![100];
  [group] = guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope);
  expect(group.entries[2]).toMatchObject({ confidence: 'unresolved', action: 'owner' });
});

it('ambiguous names and stale multipart proposals cannot produce high links', () => {
  const f = guidedFixture();
  const row = f.source.tabs[0].rows[2];
  f.source.tabs[0].rows.push({
    ...row,
    rowIndex: 99,
    cell: { plain: 'Different mechanics', runs: [{ text: 'Different mechanics' }] },
  });
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[2]).toMatchObject({ confidence: 'unresolved', action: 'owner' });
});
import { combineCompendiumMatches, snapshotCompendium, compendiumDataSchema } from '@clarity/core';
import multipartSource from './fixtures/multipart-review.json';
import { sampleReference } from './sampleReferences';
import { sourceFingerprint } from './reviewProgress';

it.each(['Blastwave Striders', 'Swarmers', 'Armorsmith'])(
  'validates actual %s card anchors without promoting neighboring headings',
  (name) => {
    const f = guidedFixture();
    const realTab = structuredClone(
      compendiumDataSchema
        .parse(multipartSource)
        .tabs.find((tab) => tab.rows.some((row) => row.name === name))!,
    );
    const rows = realTab.rows.filter((row) => row.name === name);
    realTab.rows = [...rows, f.source.tabs[0].rows[0]];
    f.source.tabs.push(realTab);
    f.baseline = `synthetic|${sourceFingerprint(f.source.tabs)}`;
    f.document.baseline = f.baseline;
    const record = f.document.categories[f.categories[0].id];
    const sample = f.categories[0].entries.find((entry) => entry.hash === 100)!;
    record.references = {
      100: sampleReference(
        sample,
        record.id,
        f.baseline,
        '',
        'picked',
        { tab: realTab, row: realTab.rows[2] },
        f.source,
      ),
    };
    f.categories[0].entries.find((entry) => entry.hash === 102)!.name = name;
    const match = combineCompendiumMatches(rows.map((row) => ({ tab: realTab, row })))!;
    if (name !== 'Armorsmith') {
      expect(match.parts).toBeUndefined();
      expect(match.row.cell).toEqual(rows[0].cell);
      return; // one merged armour card, not an unverified multipart source
    }
    expect(match.parts).toHaveLength(2);
    const expected = ['Kinetic Synthesis', 'Anti-Champion Nosecone'];
    expect(match.parts).toEqual(expected);
    f.proposals.set(102, {
      match,
      link: snapshotCompendium(match, f.source.fetchedAt),
      candidates: [],
    });
    const before = JSON.stringify(f.source);
    const [group] = guidedDecisions(
      f.document,
      f.categories,
      f.proposals,
      f.source,
      f.baseline,
      f.scope,
    );
    const decision = group.entries.find((entry) => entry.hash === 102)!;
    expect(decision).toMatchObject({
      action: 'owner',
      confidence: 'unresolved',
      ruleId: 'owner-multipart-source',
    });
    expect(decision.link).toBeUndefined();
    for (const row of rows) expect(decision.reason).toContain(JSON.stringify(row.anchor));
    expect(JSON.stringify(f.source)).toBe(before);
    expect(
      combineCompendiumMatches([...rows].reverse().map((row) => ({ tab: realTab, row })))?.parts,
    ).toEqual(match.parts);
  },
);

it('requires explicit current-artifact identity even for a unique name in the learned tab', () => {
  const f = guidedFixture();
  const record = f.document.categories[f.categories[0].id];
  record.id = 'catalog:armor-mod-seasonal';
  const category = { ...f.categories[0], id: record.id };
  const [group] = guidedDecisions(
    f.document,
    [category],
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[2]).toMatchObject({
    confidence: 'unresolved',
    action: 'owner',
    ruleId: 'owner-artifact-identity',
  });
});

it('preserves real multipart frame ordering and snapshots for explicit manual resolution', () => {
  const source = compendiumDataSchema.parse(multipartSource);
  const tab = source.tabs.find((tab) => tab.name === 'Weapon Perks')!;
  const rows = tab.rows.filter((row) => row.nameNorm === 'adaptive frame');
  expect(rows).toHaveLength(2);
  const match = combineCompendiumMatches([...rows].reverse().map((row) => ({ tab, row })))!;
  expect(match.parts).toEqual(['Intrinsic Traits', 'Rocket Launchers']);
  expect(match.row.cell.plain.indexOf(rows[0].cell.plain)).toBeLessThan(
    match.row.cell.plain.indexOf(rows[1].cell.plain),
  );
  const f = guidedFixture();
  f.source.tabs.push(tab);
  f.baseline = `synthetic|${sourceFingerprint(f.source.tabs)}`;
  f.document.baseline = f.baseline;
  const record = f.document.categories[f.categories[0].id];
  const entry = f.categories[0].entries[0];
  record.references = {
    [entry.hash]: sampleReference(entry, record.id, f.baseline, '', 'picked', match, f.source),
  };
  const [group] = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  );
  expect(group.entries[0]).toMatchObject({
    action: 'link',
    confidence: 'high',
    ruleId: 'explicit-owner',
    link: { parts: match.parts, snapshot: match.row.cell },
  });
});
