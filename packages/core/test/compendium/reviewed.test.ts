import { expect, it } from 'vitest';
import { autoLinkCompendium } from '../../src/compendium/link.js';
import {
  reviewedCompendiumNodes as nodes,
  reviewedCompendiumRules as rules,
} from '../../src/compendium/reviewed.js';
import { resolveCompendiumLink } from '../../src/compendium/resolve.js';
import { publishableHash } from '../../src/publishableHash.js';
import { compendiumDataSchema } from '../../src/compendium/types.js';
import type { Tooltip } from '../../src/schemas.js';
import fixture from './fixtures/reviewed-source.json';
import expected from './fixtures/reviewed-expected.json';
const data = compendiumDataSchema.parse(fixture);
const now = '2026-10-31T00:00:00Z';
const items = Object.fromEntries(
  Object.entries(nodes).map(([hash, n]) => [
    hash,
    { hash: Number(hash), name: n.name, categoryId: n.category },
  ]),
);
const tooltips: Record<string, Tooltip> = Object.fromEntries(
  Object.entries(nodes).map(([hash, n]) => [
    hash,
    {
      hash: Number(hash),
      text: { en: { text: n.template, updatedAt: now, updatedBy: 'audit' } },
      associated: [],
    },
  ]),
);
const snapshots: Record<string, unknown> = expected;
function run(hash: string, source = data, current = tooltips, catalog = items) {
  return autoLinkCompendium(current[hash], catalog, {}, source, now, current);
}
it.each(Object.keys(rules))(
  'round-trips audited %s with fresh styled cells and unchanged publishable hash',
  async (hash) => {
    const result = run(hash);
    expect(result.reason).toBe('linked');
    expect(result.next?.compendium?.snapshot).toEqual(snapshots[hash]);
    expect(result.next?.compendium?.cells).toEqual(rules[hash].cells);
    expect(resolveCompendiumLink(result.next!.compendium!, data).status).toBe('ok');
    expect(await publishableHash(result.next!)).toBe(await publishableHash(tooltips[hash]));
  },
);
it('refuses changed wrappers, terminal templates, categories, identity, missing and cyclic imports', () => {
  for (const hash of Object.keys(rules)) {
    for (const dependency of rules[hash].dependencies) {
      const changed = structuredClone(tooltips);
      changed[dependency].text.en!.text += '\nAdditional mechanic.';
      expect(run(hash, data, changed).next).toBeUndefined();
      const missing = { ...tooltips };
      delete missing[dependency];
      // Destination is always the caller's tooltip; missing intermediate/terminal must fail.
      if (dependency !== hash) expect(run(hash, data, missing).next).toBeUndefined();
      expect(
        run(hash, data, tooltips, {
          ...items,
          [dependency]: { ...items[dependency], categoryId: 'wrong' },
        }).next,
      ).toBeUndefined();
    }
  }
  const cyclic = structuredClone(tooltips);
  cyclic['2724068510'].text.en!.text = 'import main from 110793779';
  expect(run('110793779', data, cyclic).next).toBeUndefined();
  const wrong = structuredClone(tooltips);
  wrong['110793779'].text.en!.text = 'import main from 953234331';
  expect(run('110793779', data, wrong).next).toBeUndefined();
});
it('preserves a broken human override rather than replacing it', () => {
  const custom = {
    ...tooltips['95528736'],
    compendium: {
      gid: 'missing',
      rowKey: 'lost',
      snapshot: { plain: 'lost', runs: [{ text: 'lost' }] },
      snapshotAt: now,
    },
  };
  expect(autoLinkCompendium(custom, items, {}, data, now, tooltips).next).toBeUndefined();
});
it('follows moved anchors, refuses broken cells and duplicate anchors', () => {
  const moved = structuredClone(data);
  for (const tab of moved.tabs) {
    for (const row of tab.rows) {
      row.rowIndex += 3;
      if (row.anchor) row.anchor.row += 3;
    }
    for (const cell of tab.grid ?? []) cell.row += 3;
  }
  for (const hash of Object.keys(rules))
    expect(run(hash, moved).next?.compendium?.snapshot).toEqual(snapshots[hash]);
  const broken = structuredClone(data);
  const tab = broken.tabs.find((t) => t.gid === rules['95528736'].gid)!;
  const row = tab.rows.find((r) => r.name === 'Onslaught')!;
  tab.grid = tab.grid!.filter((c) => c.row !== row.anchor!.row || c.col !== row.anchor!.col + 2);
  expect(run('95528736', broken).next).toBeUndefined();
  const duplicate = structuredClone(data);
  const t = duplicate.tabs.find((t) => t.gid === rules['95528736'].gid)!;
  t.rows.push({ ...t.rows.find((r) => r.name === 'Onslaught')!, rowIndex: 999 });
  expect(run('95528736', duplicate).next).toBeUndefined();
});
it('keeps Chaos Accelerant confined to Aspects and Nightmare tiers to actual family sections', () => {
  expect(run('2321824285').next?.compendium).toMatchObject({
    section: 'Aspects',
    cells: [{ dRow: 0, dCol: 2 }],
  });
  for (const hash of Object.keys(rules).filter((h) => rules[h].rule === 'nightmare-tier-family'))
    expect(run(hash).next?.compendium?.section).toBe('Activity or Destination Specific');
});
it('rejects dependency aliases and alias cycles without promoting a candidate', () => {
  const hash = '110793779';
  expect(
    autoLinkCompendium(
      tooltips[hash],
      items,
      { '2724068510': { to: 953234331, kind: 'sandbox' } },
      data,
      now,
      tooltips,
    ).next,
  ).toBeUndefined();
  expect(
    autoLinkCompendium(
      tooltips[hash],
      items,
      {
        '2724068510': { to: 953234331, kind: 'sandbox' },
        '953234331': { to: 2724068510, kind: 'sandbox' },
      },
      data,
      now,
      tooltips,
    ).next,
  ).toBeUndefined();
});
import { prepareMarkup } from '../../src/markup/prepare.js';
import type { MarkupDiagnostic } from '../../src/markup/types.js';
const imports = Object.fromEntries(Object.entries(nodes).map(([h, n]) => [h, n.template]));
it('audited grant wrappers and shared mod variables retain actual converter semantics', () => {
  const imported = Object.keys(rules).filter((h) => rules[h].rule === 'explicit-main-import');
  expect(imported).toHaveLength(39);
  for (const hash of imported) {
    const diagnostics: MarkupDiagnostic[] = [];
    const prepared = prepareMarkup(
      nodes[hash].template,
      {
        variables: '',
        titles: '',
        imports,
        type:
          nodes[hash].category === 'weapon-catalyst-exotic'
            ? 'Weapon Catalyst Exotic'
            : nodes[hash].category === 'weapon-trait-enhanced'
              ? 'Weapon Trait Enhanced'
              : '',
      },
      diagnostics,
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    if (nodes[hash].category === 'armor-mod-general') {
      const override = rules[hash].dependencies
        .map((h) => /^var element = (.+)$/m.exec(nodes[h].template)?.[1])
        .find(Boolean)!;
      expect(override).toBeTruthy();
      expect(prepared.text).toContain(override);
      expect(prepared.text).not.toContain('#element');
    }
    const added = {
      ...tooltips,
      [hash]: {
        ...tooltips[hash],
        text: {
          en: { ...tooltips[hash].text.en!, text: 'Extra mechanic.\n' + nodes[hash].template },
        },
      },
    };
    expect(run(hash, data, added).next).toBeUndefined();
  }
  for (const source of ['import main from 999', 'import main from 10']) {
    const diagnostics: MarkupDiagnostic[] = [];
    prepareMarkup(
      source,
      {
        variables: '',
        titles: '',
        imports: { '10': 'import main from 11', '11': 'import main from 10' },
      },
      diagnostics,
    );
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  }
});
it('does not invent Fundamentals equivalence or a broader spelling alias', () => {
  const unknown = { ...tooltips['95528736'], hash: 2620589274 };
  expect(
    autoLinkCompendium(
      unknown,
      {
        2620589274: {
          hash: 2620589274,
          name: 'The Fundamentals',
          categoryId: 'weapon-trait-exotic',
        },
      },
      {},
      data,
      now,
      tooltips,
    ).next,
  ).toBeUndefined();
  expect(
    autoLinkCompendium(
      { ...tooltips['2940035732'], hash: 123456 },
      { 123456: { ...items['2940035732'], hash: 123456 } },
      {},
      data,
      now,
      tooltips,
    ).next,
  ).toBeUndefined();
});
it('37 ordinary import terminals agree with the bounded selection without copying snapshots', () => {
  const candidates = Object.keys(rules).filter(
    (h) => rules[h].rule === 'explicit-main-import' && rules[h].dependencies.at(-1) !== '95528736',
  );
  expect(candidates).toHaveLength(37);
  for (const hash of candidates) {
    const terminal = rules[hash].dependencies.at(-1)!;
    expect(run(terminal).next?.compendium?.snapshot).toEqual(run(hash).next?.compendium?.snapshot);
  }
});
it('rejects a nonempty unrelated cell at an unsupported description offset', () => {
  const changed = structuredClone(data);
  const tab = changed.tabs.find((t) => t.gid === rules['95528736'].gid)!;
  const row = tab.rows.find((r) => r.name === 'Onslaught')!;
  const target = tab.grid!.find((c) => c.row === row.anchor!.row && c.col === row.anchor!.col + 2)!;
  target.cell = { plain: 'Unrelated layout cell', runs: [{ text: 'Unrelated layout cell' }] };
  expect(run('95528736', changed).next).toBeUndefined();
  expect(
    run('95528736', data, tooltips, {
      ...items,
      '95528736': { ...items['95528736'], name: 'Changed' },
    }).next,
  ).toBeUndefined();
});
