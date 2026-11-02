import { expect, it } from 'vitest';
import {
  combineCompendiumMatches,
  compendiumDataSchema,
  sameCell,
  parseCompendiumSheet,
} from '@clarity/core';
import { guidedFixture } from '../../../test/guided-fixture';
import fixture from './fixtures/owner-reviewed.json';
import records from './owner-reviewed.json';
import { reviewedOwnerDecision, tentativeOwnerDecision } from './ownerReviewed';
import { proposalFor } from './rapidReview';
import { guidedDecisions } from './guidedDecisions';
import { sourceFingerprint, emptyProgress } from './reviewProgress';
import { reviewQueue } from './reviewQueue';
import type { EditorData } from '../../stores/data';

it('confirms every reviewed aspect/grenade cell and every multipart/armour destination with the real core', () => {
  const f = guidedFixture();
  f.source = compendiumDataSchema.parse(fixture.source);
  f.editor.items = fixture.items as unknown as EditorData['items'];
  f.editor.bundle.tooltips = fixture.tooltips as unknown as EditorData['bundle']['tooltips'];
  for (const rule of Object.values(records.verified)) {
    const item = f.editor.items[rule.hash];
    const entry = {
      ...f.categories[0].entries[2],
      hash: rule.hash,
      name: rule.name,
      category: item.categoryId,
      sampleEvidence: rule.entryEvidence,
      base: f.editor.bundle.tooltips[rule.hash] ?? { hash: rule.hash, text: {}, associated: [] },
    };
    const proposal = proposalFor(entry.base, f.editor, f.source);
    const decision = reviewedOwnerDecision(entry, proposal, f.source);
    expect(decision, rule.name).toMatchObject({ action: 'link', confidence: 'high' });
    expect(decision!.link!.snapshotAt).toBe(f.source.fetchedAt);
    if (rule.mode === 'multi')
      expect(decision!.link!.parts, rule.name).toHaveLength(rule.rows.length);
    if (rule.mode === 'armor') {
      expect(decision!.link!.parts).toBeUndefined();
      const tab = f.source.tabs.find((t) => t.gid === rule.gid)!;
      const rows = tab.rows.filter((r) => r.name === rule.name);
      expect(rows).toHaveLength(2);
      expect(sameCell(decision!.link!.snapshot, rows[0].cell)).toBe(true);
      expect(decision!.link!.snapshot.plain).not.toMatch(
        /Wraithmetal Mail|Speedloader Slacks|Tight Fit/,
      );
      // Identical text in a DIFFERENT physical cell is not a duplicate card.
      const moved = { ...rows[1], rowIndex: 999, anchor: { row: 999, col: rows[1].anchor!.col } };
      expect(
        combineCompendiumMatches([
          { tab, row: rows[0] },
          { tab, row: moved },
        ])?.parts,
      ).toHaveLength(2);
    }
    const tab = f.source.tabs.find((t) => t.gid === rule.gid)!;
    const row = tab.rows.find(
      (r) => r.anchor?.row === rule.rows[0].anchor.row && r.anchor?.col === rule.rows[0].anchor.col,
    )!;
    const original = structuredClone(row.cell);
    row.cell = {
      plain: 'Wrong neighboring mechanics',
      runs: [{ text: 'Wrong neighboring mechanics' }],
    };
    expect(reviewedOwnerDecision(entry, proposal, f.source)).toMatchObject({ action: 'owner' });
    row.cell = original;
  }
});
it('uses existing fingerprints to reopen every tentative no-equivalent after sheet or item changes', () => {
  const f = guidedFixture();
  expect(records.noEquivalent).toHaveLength(29);
  for (const record of records.noEquivalent) {
    const entry = {
      ...f.categories[0].entries[2],
      hash: record.hash,
      name: record.name,
      category: record.categoryId.slice('catalog:'.length),
      sampleEvidence: record.entryEvidence,
    };
    expect(tentativeOwnerDecision(entry, records.sourceFingerprint), record.name).toBe(true);
    const changed = structuredClone(f.source);
    changed.tabs[0].rows.push({
      ...changed.tabs[0].rows[0],
      name: record.name,
      nameNorm: record.name.toLowerCase(),
    });
    expect(tentativeOwnerDecision(entry, sourceFingerprint(changed.tabs)), record.name).toBe(false);
    expect(
      tentativeOwnerDecision(
        { ...entry, sampleEvidence: 'changed English/catalog evidence' },
        records.sourceFingerprint,
      ),
    ).toBe(false);
  }
});
it('continues to show blank authored-English tooltips and refuses changed multipart identity sets', () => {
  const f = guidedFixture(),
    hash = 1294026524;
  f.editor.items = fixture.items as unknown as EditorData['items'];
  f.editor.bundle.tooltips = {};
  f.source = compendiumDataSchema.parse(fixture.source);
  const queue = reviewQueue(
    f.editor,
    f.source,
    {},
    emptyProgress(),
    sourceFingerprint(f.source.tabs),
  );
  expect(queue.some((e) => e.hash === hash && !e.base.text.en?.text)).toBe(true);
  const rule = records.verified[hash];
  const category = f.categories[0],
    record = f.document.categories[category.id];
  category.id = record.id = 'catalog:weapon-frame';
  record.hashes = [hash];
  record.references = {};
  category.entries = [
    {
      ...category.entries[2],
      hash,
      name: 'Adaptive Frame',
      category: 'weapon-frame',
      sampleEvidence: rule.entryEvidence,
      base: { hash, text: {}, associated: [] },
    },
  ];
  const entry = category.entries[0];
  const proposals = new Map([[hash, proposalFor(entry.base, f.editor, f.source)]]);
  const decide = () =>
    guidedDecisions(f.document, [category], proposals, f.source, f.baseline, f.scope)[0].entries[0];
  expect(decide().link?.parts).toHaveLength(2);
  const tab = f.source.tabs.find((t) => t.gid === rule.gid)!;
  tab.rows.push({ ...tab.rows.find((r) => r.name === 'Adaptive Frame')!, rowIndex: 999 });
  expect(decide()).toMatchObject({ action: 'owner', confidence: 'unresolved' });
});
it('does not parse two exotic armour records from the item name repeated over one merged description', () => {
  const html =
    '<table><tr><th>1</th><td>Name</td><td></td><td>Description</td></tr>' +
    '<tr><th>2</th><td>Swarmers</td><td></td><td rowspan="3">Spawns 2 Threadlings on Tangle destruction.</td></tr>' +
    '<tr><th>3</th><td></td><td></td></tr><tr><th>4</th><td>Swarmers</td><td></td></tr></table>';
  const sheet = parseCompendiumSheet(html, '1500097863', 'Exotic Armors');
  expect(sheet.rows.filter((r) => r.name === 'Swarmers')).toHaveLength(1);
});

it('does not reuse one matching body as proof for several identical-named charged rows', () => {
  const f = guidedFixture();
  f.source = compendiumDataSchema.parse(fixture.source);
  f.editor.items = fixture.items as unknown as EditorData['items'];
  f.editor.bundle.tooltips = fixture.tooltips as unknown as EditorData['bundle']['tooltips'];
  const hash = 2321824285,
    rule = records.verified[hash];
  const tab = f.source.tabs.find((t) => t.gid === rule.gid)!;
  const charged = tab.rows.filter((r) => r.name.includes('(Charged)'));
  expect(charged).toHaveLength(3);
  const entry = {
    ...f.categories[0].entries[2],
    hash,
    name: rule.name,
    category: 'subclass-aspect',
    sampleEvidence: rule.entryEvidence,
    base: f.editor.bundle.tooltips[hash],
  };
  const proposal = proposalFor(entry.base, f.editor, f.source);
  charged[1].cell = structuredClone(charged[0].cell);
  expect(reviewedOwnerDecision(entry, proposal, f.source)?.action).toBe('owner');
});
