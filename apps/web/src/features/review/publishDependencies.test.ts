import { expect, it } from 'vitest';
import {
  applyInactiveLive,
  exportLegacy,
  mergeLivePerks,
  publishableHash,
  type Aliases,
  type InactiveMoves,
  type Tooltip,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { PendingTooltip } from './model';
import { planReviewedPublish } from './publishAction';
import { publishDependencies } from './publishDependencies';
import { publishChunks } from './publishDriver';
import { usePublished } from './published';

const t = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' } },
  associated: [],
});
const move = { by: 1, at: '2026-11-14T00:00:00Z' };
it.each([
  [301, 1],
  [1306, 18],
])('splits %i reviewed rows with %i removals into bounded requests', (total, removals) => {
  const removed = Array.from({ length: removals }, (_, index) => t(100 + index, 'Remove me'));
  const edited = removed.map(({ hash }) => t(hash + 100, 'No longer imports the target'));
  const unrelated = Array.from({ length: total - 2 * removals }, (_, index) =>
    t(1000 + index, 'Unrelated'),
  );
  const selected = [...removed, ...edited, ...unrelated];
  const tooltips = Object.fromEntries(selected.map((tooltip) => [tooltip.hash, tooltip]));
  const moves = Object.fromEntries(
    removed.map(({ hash }) => [hash, { by: 1, at: '2026-11-14T00:00:00Z' }]),
  );
  const published = Object.fromEntries(
    edited.map(({ hash }) => [hash, t(hash, `import main from ${hash - 100}`)]),
  );
  const deps = publishDependencies(tooltips, {}, new Set(selected.map((t) => t.hash)), selected, {
    moves,
    published,
  });
  const chunks = publishChunks(
    selected.map(({ hash }) => ({ hash, previous: undefined, dependencies: deps.get(hash) })),
  );
  const positions = new Map(
    chunks.flatMap((chunk, index) => chunk.map(({ hash }) => [hash, index] as const)),
  );
  expect(positions.size).toBe(total);
  expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(50);
  for (const { hash } of removed) {
    expect(deps.get(hash)).toContain(hash + 100);
    expect(positions.get(hash + 100)).toBeLessThanOrEqual(positions.get(hash)!);
  }
  for (const { hash } of unrelated) expect(deps.get(hash)).toEqual([]);
});

it('groups live alias and nested readers with the removal when the old alias is uncertain', () => {
  const moves = { 100: { by: 1, at: '2026-11-14T00:00:00Z' } };
  const target = t(100, 'Remove me');
  const aliases = { 101: { to: 100, kind: 'name' } } as const;
  const readers = Array.from({ length: 300 }, (_, index) => t(200 + index, 'Repaired'));
  const selected = [target, ...readers];
  const old = Object.fromEntries(
    readers.map(({ hash }) => [hash, t(hash, `import main from ${hash === 200 ? 101 : 200}`)]),
  );
  const deps = publishDependencies(
    Object.fromEntries(selected.map((tooltip) => [tooltip.hash, tooltip])),
    aliases,
    new Set(selected.map((t) => t.hash)),
    selected,
    { moves, published: old },
  );
  const chunks = publishChunks(
    selected.map(({ hash }) => ({ hash, previous: undefined, dependencies: deps.get(hash) })),
  );
  expect(chunks.map((chunk) => chunk.length)).toEqual([301]);
  const tooltips = new Map(selected.map((tooltip) => [tooltip.hash, tooltip]));
  const initial = exportLegacy([target, ...Object.values(old)], 0, undefined, aliases);
  const apply = (live: Record<string, unknown>, hashes: number[]) => {
    const entries = exportLegacy(
      hashes.filter((hash) => hash !== 100).map((hash) => tooltips.get(hash)!),
      0,
      undefined,
      aliases,
    );
    return applyInactiveLive(mergeLivePerks(live, entries), moves, hashes, aliases, live);
  };
  expect(() => apply(initial, [100])).toThrow(/imports inactive/);
  const final = chunks.reduce<Record<string, unknown>>(
    (live, chunk) =>
      apply(
        live,
        chunk.map(({ hash }) => hash),
      ),
    initial,
  );
  expect(final).toEqual(
    apply(
      initial,
      selected.map(({ hash }) => hash),
    ),
  );
});

it.each([undefined, 103])(
  'publishes a selected repair before removal when the old alias now points to %s',
  (newTarget) => {
    const target = t(100, 'Remove me');
    const oldReader = { ...t(300, 'Reader'), associated: [101] };
    const repair = t(300, 'Repaired');
    const filler = Array.from({ length: 50 }, (_, index) => t(200 + index, 'Filler'));
    const selected = [target, ...filler, repair];
    const saved = Object.fromEntries(selected.map((tooltip) => [tooltip.hash, tooltip]));
    const aliases: Aliases = newTarget ? { 101: { to: newTarget, kind: 'frame' } } : {};
    const moves = { 100: { by: 1, at: '2026-11-14T00:00:00Z' } };
    const deps = publishDependencies(
      saved,
      aliases,
      new Set(selected.map((t) => t.hash)),
      selected,
      {
        moves,
        published: { 100: target, 300: oldReader },
      },
    );
    const chunks = publishChunks(
      selected.map(({ hash }) => ({
        hash,
        previous: undefined,
        dependencies: deps.get(hash),
        removal: hash === 100,
      })),
    );
    const live = exportLegacy([target, ...filler, oldReader], 0, undefined, {
      101: { to: 100, kind: 'frame' },
    });
    function apply(previous: Record<string, unknown>, hashes: number[]) {
      const entries = exportLegacy(
        hashes.filter((hash) => hash !== 100).map((hash) => saved[hash]!),
        0,
        undefined,
        aliases,
      );
      return applyInactiveLive(mergeLivePerks(previous, entries), moves, hashes, aliases, previous);
    }
    expect(() => apply(live, [100])).toThrow(/associates inactive/);
    expect(chunks.find((chunk) => chunk.some(({ hash }) => hash === 100))).toContainEqual(
      expect.objectContaining({ hash: 300 }),
    );
    expect(
      chunks.reduce<Record<string, unknown>>(
        (previous, chunk) =>
          apply(
            previous,
            chunk.map(({ hash }) => hash),
          ),
        live,
      ),
    ).toEqual(
      apply(
        live,
        selected.map(({ hash }) => hash),
      ),
    );
  },
);

it('waits for comparison states and splits 501 independent removals once ready', () => {
  const rows = Array.from({ length: 501 }, (_, index) => t(100 + index, 'Independent'));
  const entries = rows.map((tooltip) => ({
    tooltip,
    name: `Tooltip ${tooltip.hash}`,
    inactiveChange: 'remove',
    pushed: 'old',
  })) as PendingTooltip[];
  const data = {
    aliases: {},
    bundle: {
      tooltips: Object.fromEntries(rows.map((tooltip) => [tooltip.hash, tooltip])),
      inactiveMoves: Object.fromEntries(
        rows.map(({ hash }) => [hash, { by: 1, at: '2026-11-14T00:00:00Z' }]),
      ),
      pushed: Object.fromEntries(rows.map(({ hash }) => [hash, 'old'])),
    },
  } as EditorData;
  const before = usePublished.getState().byHash;
  try {
    usePublished.setState({ byHash: {} });
    expect(() => planReviewedPublish(entries, entries, data)).toThrow(
      'Wait for the published versions to load, then publish again.',
    );
    usePublished.setState({
      byHash: { 100: { marker: 'old', status: 'error', error: 'Offline' } },
    });
    expect(() => planReviewedPublish(entries, entries, data)).toThrow('Refresh Review to retry');
    usePublished.setState({ byHash: { 100: { marker: 'old', status: 'missing' } } });
    expect(() => planReviewedPublish(entries, entries, data)).toThrow('could not be recovered');
    usePublished.setState({
      byHash: Object.fromEntries(
        rows.map((tooltip) => [tooltip.hash, { marker: 'old', status: 'ready', tooltip }]),
      ),
    });
    expect(
      publishChunks(planReviewedPublish(entries, entries, data)).map((chunk) => chunk.length),
    ).toEqual([50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 1]);
  } finally {
    usePublished.setState({ byHash: before });
  }
});

function reviewPlan(
  rows: Tooltip[],
  archived: Tooltip[],
  aliases: Aliases,
  inactiveMoves: InactiveMoves,
  loading?: number,
) {
  const pushed = Object.fromEntries(archived.map(({ hash }) => [hash, 'old']));
  const entries = rows.map((tooltip) => ({
    tooltip,
    name: `Tooltip ${tooltip.hash}`,
    pushed: pushed[tooltip.hash],
    inactiveChange: inactiveMoves[tooltip.hash] ? 'remove' : undefined,
    inactiveAliases: Object.keys(inactiveMoves)
      .map(Number)
      .filter((hash) => aliases[hash]?.to === tooltip.hash),
  })) as PendingTooltip[];
  const data = {
    aliases,
    bundle: {
      tooltips: Object.fromEntries(rows.map((tooltip) => [tooltip.hash, tooltip])),
      pushed,
      inactiveMoves,
    },
  } as EditorData;
  const before = usePublished.getState().byHash;
  try {
    usePublished.setState({
      byHash: Object.fromEntries(
        archived.map((tooltip) => [
          tooltip.hash,
          tooltip.hash === loading
            ? { status: 'loading', marker: 'old' }
            : { status: 'ready', marker: 'old', tooltip },
        ]),
      ),
    });
    return publishChunks(planReviewedPublish(entries, entries, data)).map((chunk) =>
      chunk.map(({ hash }) => hash),
    );
  } finally {
    usePublished.setState({ byHash: before });
  }
}

it('keeps a possible live reader with a removal even when the saved alias points to a retained row', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    ...t(1000 + index, 'Reader'),
    associated: [901],
  }));
  const retained = t(900, 'Retained target');
  const aliases = { 901: { to: retained.hash, kind: 'frame' } } as const;
  const moves = Object.fromEntries(rows.map(({ hash }) => [hash, move]));
  const reader = rows[59]!;
  const target = rows[0]!;
  const oldAliases = { 901: { to: target.hash, kind: 'frame' } } as const;
  // The same archived tooltip and marker can export two different associations.
  expect(await publishableHash(reader, oldAliases)).toBe(await publishableHash(reader, aliases));
  const stable = exportLegacy([retained, ...rows], 0, undefined, aliases);
  const retargeted = mergeLivePerks(stable, exportLegacy([reader], 0, undefined, oldAliases));
  expect(stable[reader.hash]).toHaveProperty('associated', [retained.hash]);
  expect(retargeted[reader.hash]).toHaveProperty('associated', [target.hash]);
  expect(() => applyInactiveLive(retargeted, moves, [target.hash], aliases)).toThrow(
    /associates inactive/,
  );
  const chunks = reviewPlan(rows, rows, aliases, moves);
  expect(chunks.map((chunk) => chunk.length)).toEqual([60]);
  for (const live of [stable, retargeted])
    expect(
      chunks.reduce((state, hashes) => applyInactiveLive(state, moves, hashes, aliases), live),
    ).toEqual(
      applyInactiveLive(
        live,
        moves,
        rows.map(({ hash }) => hash),
        aliases,
      ),
    );
});

it.each([true, false])(
  'names an over-limit group before confirmation (ambiguous = %s)',
  (ambiguous) => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      ...t(1000 + index, 'Reader'),
      associated: [ambiguous ? 901 : 1000 + ((index + 1) % 501)],
    }));
    const moves = Object.fromEntries(rows.map(({ hash }) => [hash, move]));
    expect(() => reviewPlan(rows, rows, { 901: { to: 900, kind: 'frame' } }, moves)).toThrow(
      /cannot safely split.*501 tooltip languages.*500 per request.*Tooltip 1000.*Tooltip 1500/,
    );
  },
);

it('waits for a repair comparison when an active dependency would pull a stub removal ahead', () => {
  const user = { ...t(10, 'Uses canonical'), associated: [100] };
  const owner = t(100, 'Still active');
  const oldReader = t(900, 'import main from 101');
  const repair = t(900, 'Repaired');
  const filler = Array.from({ length: 50 }, (_, index) => t(200 + index, 'Unrelated'));
  const selected = [user, owner, repair, ...filler];
  const aliases = { 101: { to: 100, kind: 'name' } } as const;
  const moves = { 101: move };
  const archived = [owner, oldReader];
  expect(() => reviewPlan(selected, archived, aliases, moves, 900)).toThrow(
    'Wait for the published versions to load',
  );
  const initial = exportLegacy(archived, 0, undefined, aliases);
  const apply = (previous: Record<string, unknown>, hashes: number[]) => {
    const entries = exportLegacy(
      selected.filter(({ hash }) => hashes.includes(hash)),
      0,
      undefined,
      aliases,
    );
    return applyInactiveLive(mergeLivePerks(previous, entries), moves, hashes, aliases, previous);
  };
  expect(() => apply(initial, [10, 100])).toThrow(/Tooltip 900 imports inactive tooltip 100/);
  const chunks = reviewPlan(selected, archived, aliases, moves);
  expect(chunks.reduce(apply, initial)).toEqual(
    apply(
      initial,
      selected.map(({ hash }) => hash),
    ),
  );
});

it('observes exact, nested, alias, and cyclic imports through the real resolver', () => {
  const tooltips = Object.fromEntries(
    [
      t(1209885908, 'import main from 2152442764'),
      t(2152442764, 'import main from 300'),
      t(300, 'Resolved'),
      t(400, 'import main from 500'),
      t(500, 'import main from 400'),
    ].map((t) => [t.hash, t]),
  );
  const pending = new Set(Object.values(tooltips).map((t) => t.hash));
  const deps = publishDependencies(tooltips, {}, pending, Object.values(tooltips));
  expect(deps.get(1209885908)).toContain(2152442764);
  expect(deps.get(1209885908)).toContain(300);
  expect(deps.get(400)).toContain(500);
  const alias = t(600, 'import main from 700');
  expect(
    publishDependencies({ ...tooltips, 600: alias }, { 700: { to: 300, kind: 'name' } }, pending, [
      alias,
    ]).get(600),
  ).toContain(300);
});
it('orders pending global libraries and observes imports inside a global title', () => {
  const consumer = t(100, '<title Info [Tip] />');
  const titles = t(3, 'title Tip (\nimport main from 200\n)');
  const target = t(200, 'Resolved');
  const deps = publishDependencies(
    { 100: consumer, 3: titles, 200: target },
    {},
    new Set([3, 200]),
    [consumer],
  );
  expect(deps.get(100)).toContain(3);
  expect(deps.get(100)).toContain(200);
});

it('requires a pending globals aggregate only for a concrete import with per-entry release', () => {
  const independent = t(100, 'Plain text');
  const importer = t(200, 'import main from 1');
  const tooltips = { 1: t(1, 'Global exports'), 100: independent, 200: importer };
  const deps = publishDependencies(tooltips, {}, new Set([1]), [independent, importer], {
    globals: true,
  });
  expect(deps.get(100)).toEqual([]);
  expect(deps.get(200)).toEqual([1]);
});
