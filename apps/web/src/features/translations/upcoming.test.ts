import { describe, expect, it } from 'vitest';
import type { Lang, LangText, Tooltip } from '@clarity/core';
import type { BatchMember } from '@clarity/core/schedule';
import type { EditorData } from '../../stores/data';
import { upcomingState } from '../tooltip/UpcomingSwitch.load';
import type { OpenBatch } from '../tooltip/UpcomingSwitch.store';
import {
  countUpcoming,
  filterUpcoming,
  upcomingCategories,
  upcomingCoverage,
  upcomingRows,
  type LoadedBatch,
} from './upcoming';

const t0 = '2026-10-01T00:00:00.000Z';
const t1 = '2026-11-01T00:00:00.000Z';
const t2 = '2026-11-10T00:00:00.000Z';
const entry = (text: string, updatedAt: string, sourceUpdatedAt?: string): LangText => ({
  text,
  updatedAt,
  updatedBy: 'x',
  ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
});
const tooltip = (hash: number, text: Partial<Record<Lang, LangText>>, extra = {}): Tooltip => ({
  hash,
  associated: [],
  text,
  ...extra,
});
const categories = [
  { id: 'perks', label: 'Perks', group: 'Weapons', order: 1 },
  { id: 'mods', label: 'Mods', group: 'Armor', order: 2 },
];
const names: Record<number, [string, string]> = {
  1: ['Alpha', 'perks'],
  2: ['Bravo', 'perks'],
  3: ['Charlie', 'mods'],
  4: ['Delta', 'perks'],
  5: ['Echo', 'perks'],
  6: ['Foxtrot', 'perks'],
  7: ['Golf', 'mods'],
};
function build(tooltips: Tooltip[]): EditorData {
  return {
    categories,
    items: Object.fromEntries(
      Object.entries(names).map(([hash, [name, categoryId]]) => [
        hash,
        { hash: Number(hash), name, icon: '', categoryId, inGameDescription: '' },
      ]),
    ),
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: t0,
      tooltips: Object.fromEntries(tooltips.map((value) => [value.hash, value])),
      permissions: { users: {} },
      pushed: {},
    },
  } as EditorData;
}
const member = (base: Tooltip | null, proposed: Tooltip): BatchMember => ({
  hash: proposed.hash,
  base,
  baseCommit: '0'.repeat(40),
  proposed,
  updatedAt: t2,
  updatedBy: 'x',
});

// Current saved: German written against the current English everywhere it exists.
const current = {
  1: tooltip(1, { en: entry('One', t0), de: entry('Eins', t0, t0) }),
  2: tooltip(2, { en: entry('Two', t0), de: entry('Zwei', t0, t0) }),
  3: tooltip(3, { en: entry('Three', t0), de: entry('Drei', t0, t0) }),
  // Current German edited after the batch took its base (Q4).
  4: tooltip(4, { en: entry('Four', t0), de: entry('Vier, neu', t2, t0) }),
  5: tooltip(5, { en: entry('Five', t0) }),
};
const base4 = tooltip(4, { en: entry('Four', t0), de: entry('Vier', t0, t0) });
const members = [
  // English changes, no batch German: needs translation.
  member(current[1], tooltip(1, { en: entry('One new', t1), de: entry('Eins', t0, t0) })),
  // English changes and the batch German was written against it: ready.
  member(current[2], tooltip(2, { en: entry('Two new', t1), de: entry('Zwei neu', t1, t1) })),
  // The batch English changed again after its German: stale.
  member(current[3], tooltip(3, { en: entry('Three newer', t2), de: entry('Drei neu', t1, t1) })),
  // Ready in the batch, but current German changed meanwhile: current changed.
  member(base4, tooltip(4, { en: entry('Four new', t1), de: entry('Vier neu', t1, t1) })),
  // English unchanged (an association-only change): no row.
  member(current[5], tooltip(5, { en: entry('Five', t0) }, { associated: [1] })),
  // A tooltip the batch creates: no current English, so it is listed.
  member(null, tooltip(6, { en: entry('Six', t1) })),
  // Archived once published: never translatable.
  member(null, tooltip(7, { en: entry('Seven', t1) }, { archive: { at: t1 } })),
];
const data = build(Object.values(current));
const batch: OpenBatch = {
  id: '01JFAAAAAAAAAAAAAAAAAAAAAA',
  name: 'December patch',
  status: 'draft',
  notBefore: null,
  revision: 3,
  hashes: members.map((value) => value.hash),
};
const loaded: LoadedBatch[] = [{ batch, upcoming: upcomingState(members, data) }];

describe('upcomingRows', () => {
  it('lists members whose English changes, with their state per language', () => {
    const rows = upcomingRows(data, loaded, 'de');
    expect(rows.map((row) => [row.name, row.state, row.currentChanged])).toEqual([
      ['Alpha', 'needs', false],
      ['Foxtrot', 'needs', false],
      ['Charlie', 'stale', false],
      ['Delta', 'changed', true],
      ['Bravo', 'ready', false],
    ]);
    expect(rows[0]).toMatchObject({
      key: `${batch.id}:1:de`,
      batchId: batch.id,
      batchName: 'December patch',
      category: 'Perks',
    });
  });

  it('treats another language without batch text as needing translation', () => {
    const rows = upcomingRows(data, loaded, 'fr');
    expect(rows.every((row) => row.state === 'needs')).toBe(true);
    expect(rows).toHaveLength(5);
  });

  it('flags current changed on a stale row too', () => {
    const stale4 = member(
      base4,
      tooltip(4, { en: entry('Four newer', t2), de: entry('Vier neu', t1, t1) }),
    );
    const rows = upcomingRows(
      data,
      [{ batch: { ...batch, hashes: [4] }, upcoming: upcomingState([stale4], data) }],
      'de',
    );
    expect(rows.map((row) => [row.state, row.currentChanged])).toEqual([['stale', true]]);
  });

  it('stops listing a member once current English equals the batch English', () => {
    const caught = build([
      ...Object.values(current).filter((value) => value.hash !== 2),
      tooltip(2, { en: entry('Two new', t1), de: entry('Zwei', t0, t0) }),
    ]);
    const rows = upcomingRows(caught, [{ batch, upcoming: upcomingState(members, caught) }], 'de');
    expect(rows.some((row) => row.hash === 2)).toBe(false);
  });

  it('filters, counts, and covers by state and category', () => {
    const rows = upcomingRows(data, loaded, 'de');
    expect(countUpcoming(rows)).toEqual({ todo: 4, ready: 1 });
    expect(filterUpcoming(rows, { state: 'ready', category: null, query: '' })).toHaveLength(1);
    expect(filterUpcoming(rows, { state: 'todo', category: 'mods', query: '' })).toHaveLength(1);
    expect(filterUpcoming(rows, { state: null, category: null, query: 'december' })).toHaveLength(
      5,
    );
    expect(upcomingCoverage(rows)).toEqual({ ready: 1, changed: 1, stale: 1, needs: 2 });
    expect(upcomingCoverage(rows, 'mods')).toEqual({ ready: 0, changed: 0, stale: 1, needs: 0 });
    expect(upcomingCategories(rows)).toEqual([
      { id: 'perks', label: 'Perks', count: 4 },
      { id: 'mods', label: 'Mods', count: 1 },
    ]);
  });
});
