import { expect, it } from 'vitest';
import { compendiumDataSchema, resolveCompendiumLink } from '@clarity/core';
import fixture from './fixtures/compendium-links.json';
import { guidedFixture } from '../../../test/guided-fixture';
import { inferredSetBonusDecision } from './safeSourceRules';
import { reviewedOwnerDecision } from './ownerReviewed';
import { reviewCategories } from './reviewCategories';
import { reviewQueue } from './reviewQueue';
import { emptyProgress } from './reviewProgress';
import { displayMatches } from './displayMatches';
import type { EditorData } from '../../stores/data';

function setup() {
  const f = guidedFixture();
  f.source = compendiumDataSchema.parse(fixture.source);
  f.editor.items = fixture.items as EditorData['items'];
  f.editor.bundle.tooltips = {};
  const entries = reviewCategories(
    reviewQueue(f.editor, f.source, {}, emptyProgress(), ''),
    f.editor,
    new Map(),
    false,
    false,
    f.source,
  ).flatMap((c) => c.entries);
  return { ...f, entries };
}
it('links all ten newly approved set perks and only their exact piece blocks', () => {
  const f = setup();
  const selected = f.entries.filter((e) => e.setBonus?.setName.endsWith(' Set'));
  expect(selected).toHaveLength(10);
  for (const entry of selected) {
    const decision = inferredSetBonusDecision(entry, f.source)!;
    expect(decision.action, entry.name).toBe('link');
    expect(decision.link!.snapshot.plain).toContain(`${entry.setBonus!.pieceCount} Piece`);
    expect(decision.link!.snapshot.plain).not.toContain(
      `${entry.setBonus!.pieceCount === 2 ? 4 : 2} Piece`,
    );
    expect(resolveCompendiumLink(decision.link!, f.source).status).toBe('ok');
    expect(
      inferredSetBonusDecision({ ...entry, name: entry.name + ' incorrect' }, f.source)?.action,
    ).toBe('owner');
    expect(
      inferredSetBonusDecision(
        {
          ...entry,
          setBonus: { ...entry.setBonus!, pieceCount: entry.setBonus!.pieceCount === 2 ? 4 : 2 },
        },
        f.source,
      )?.action,
    ).toBe('owner');
  }
  const entry = selected[0];
  const tab = f.source.tabs.find((t) => t.name === 'Armor Perks')!;
  tab.rows.push(structuredClone(tab.rows.find((r) => r.name.startsWith('Disaster Corps'))!));
  expect(inferredSetBonusDecision(entry, f.source)?.action).toBe('owner');
  expect(
    inferredSetBonusDecision({ ...entry, category: 'armor-mod-general' }, f.source),
  ).toBeUndefined();
});
it('replays all four explicit Collective approvals and rejects source or item drift', () => {
  const f = setup();
  for (const entry of f.entries.filter((e) => e.category.startsWith('weapon-trait'))) {
    const decision = reviewedOwnerDecision(entry, undefined, f.source)!;
    expect(decision.action, entry.name).toBe('link');
    const resolved = resolveCompendiumLink(decision.link!, f.source);
    expect(resolved.status).toBe('ok');
    if (!('row' in resolved)) throw new Error('Missing picked source');
    expect(resolved.row.anchor?.row).toBe(entry.name === 'Collective Demolition' ? 52 : 53);
    expect(reviewedOwnerDecision({ ...entry, name: 'Wrong' }, undefined, f.source)?.action).toBe(
      'owner',
    );
    const changed = structuredClone(f.source);
    changed.tabs
      .find((t) => t.gid === decision.link!.gid)!
      .rows.find((r) => r.rowIndex === resolved.row.rowIndex)!.cell = {
      plain: 'changed',
      runs: [{ text: 'changed' }],
    };
    expect(reviewedOwnerDecision(entry, undefined, changed)?.action).toBe('owner');
  }
});
it('makes the fourteen approvals available with shipped guidance and fresh storage', () => {
  const f = setup();
  const result = displayMatches(
    f.editor,
    f.source,
    {},
    emptyProgress(),
    undefined,
    'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json|https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json',
    new Map(),
  );
  const wanted = f.entries.filter(
    (e) => e.category.startsWith('weapon-trait') || e.setBonus?.setName.endsWith(' Set'),
  );
  expect(wanted).toHaveLength(14);
  for (const e of wanted) expect(result.matches.has(e.hash), e.name).toBe(true);
});
it('records the full set-perk census, leaving the mismatched perk unresolved', () => {
  const f = setup();
  const results = f.entries
    .filter((e) => e.category === 'armor-set-bonus')
    .map((e) => ({
      hash: e.hash,
      name: e.name,
      action: inferredSetBonusDecision(e, f.source)?.action,
    }));
  expect(results.filter((r) => r.action === 'link')).toHaveLength(111);
  expect(results.filter((r) => r.action !== 'link').map((r) => r.name)).toEqual([
    "Legacy's Oath (4 pc): God-like Judgment",
  ]);
  expect(results).toMatchSnapshot();
});
