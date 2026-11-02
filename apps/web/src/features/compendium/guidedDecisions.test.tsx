import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { guidedDecisions, guidedRevision } from './guidedDecisions';
import { GuidedPreview } from './GuidedPreview';
import { proposalFor } from './rapidReview';
import { loadManifestFacts } from './manifestFacts';

it('chooses an artifact section using manifest membership when names repeat', () => {
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
  tab.grid.push({ row: 31, col: 1, cell: tab.rows[1].cell });
  const decision = guidedDecisions(
    f.document,
    f.categories,
    f.proposals,
    f.source,
    f.baseline,
    f.scope,
  )[0].entries[2];
  expect(decision).toMatchObject({
    action: 'link',
    ruleId: 'artifact-manifest-section',
    link: { section: 'Reclamation' },
  });
  // The old preview family falsely says Implement of Curiosity. Only socket parents count.
  const decide = () =>
    guidedDecisions(f.document, f.categories, f.proposals, f.source, f.baseline, f.scope)[0]
      .entries[2];
  entry.manifestFacts.item.artifactMemberships = [
    { source: 'socket', artifactHash: 1, artifactName: 'Sunset Artifact', ownerHash: 2 },
  ];
  expect(decide()).toMatchObject({ action: 'out-of-scope', ruleId: 'artifact-sunset' });
  entry.manifestFacts.item.artifactMemberships[0].artifactName = 'Other Artifact';
  tab.grid.push({ row: 11, col: 1, cell: tab.rows[0].cell });
  expect(decide()).toMatchObject({ action: 'link', link: { section: 'Other' } });
  entry.manifestFacts.item.artifactMemberships[0].artifactName = 'Unknown Artifact';
  expect(decide().link).toBeUndefined();
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
  for (const [name, row, gid] of [
    ['Harmonic Dexterity', 'Dexterity', '1934379638'],
    ['Set Bonus: AION Adapter', 'AION Adapter', '1287885342'],
  ]) {
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

it('withholds fuzzy proposals and makes preview-only scope and spot-check limitations visible', () => {
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
  const html = renderToStaticMarkup(
    createElement(GuidedPreview, { ...f, category: f.categories[0] }),
  );
  expect(html).toContain('6 recorded entries');
  expect(html).toContain('not individual review');
  expect(html).toContain('local link-only drafts');
  expect(html).not.toContain('Accept category');
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
  'withholds actual %s card anchors instead of promoting resolver-generated neighboring headings',
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
    expect(match.parts).toHaveLength(2);
    const expected =
      name === 'Blastwave Striders'
        ? ["The Dragon's Shadow", 'Wraithmetal Mail']
        : name === 'Swarmers'
          ? ['Speedloader Slacks', 'Tight Fit']
          : ['Kinetic Synthesis', 'Anti-Champion Nosecone'];
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
