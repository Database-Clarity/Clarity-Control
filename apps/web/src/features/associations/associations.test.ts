import { describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { associationCandidates, moveAssociation } from './associations';
import { resolveAlias } from '@clarity/core';
import { itemFor } from '../navigation/catalog';

const item = (hash: number, name: string) => ({
  hash,
  name,
  categoryId: 'verbs',
  icon: '',
  inGameDescription: '',
});
const data: EditorData = {
  categories: [],
  items: {
    10: item(10, 'Self'),
    20: item(20, 'Scorch'),
    30: item(30, 'Blind'),
    99: item(99, 'Alias scorch'),
  },
  aliases: { 99: { to: 20, kind: 'sandbox' }, 100: { to: 99, kind: 'frame' } },
  bundle: {
    sourceCommit: 'test',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: {},
    pushed: {},
    permissions: { users: {} },
  },
};

describe('association picker', () => {
  it('matches the uncached picker across alias queries, exclusions, and data replacements', () => {
    // Preserve the previous consumer output as the equivalence oracle.
    const previous = (source: EditorData, query: string, self: number, selected: number[]) => {
      const search = query.trim().toLowerCase();
      const excluded = new Set(
        [self, ...selected].map((hash) => resolveAlias(hash, source.aliases)),
      );
      const matches = new Set<number>();
      const hashes = new Set([
        ...Object.keys(source.items),
        ...Object.keys(source.bundle.tooltips),
        ...Object.keys(source.aliases),
      ]);
      for (const hash of hashes) {
        const canonical = resolveAlias(Number(hash), source.aliases);
        if (excluded.has(canonical) || canonical <= 3 || source.bundle.tooltips[canonical]?.archive)
          continue;
        const entry = itemFor(Number(hash), source) ?? itemFor(canonical, source);
        if (!search || hash.includes(search) || entry?.name.toLowerCase().includes(search))
          matches.add(canonical);
      }
      return [...matches].sort(
        (a, b) =>
          (itemFor(a, source)?.name ?? '').localeCompare(itemFor(b, source)?.name ?? '') || a - b,
      );
    };
    for (const source of [
      data,
      { ...data, items: { ...data.items, 40: item(40, 'Scorch'), 50: item(50, 'Éclair') } },
    ])
      for (const query of ['', ' ', 'Scorch', 'SCOR', '99', '100', 'alias', '0', 'é', 'absent'])
        for (const self of [0, 10, 99, 100, 30])
          for (const selected of [[], [20], [99], [100, 30]])
            expect(associationCandidates(source, query, self, selected)).toEqual(
              previous(source, query, self, selected),
            );
  });
  it('searches verbs by name, canonical hashes and alias hashes', () => {
    expect(associationCandidates(data, 'scorch', 10, [])).toEqual([20]);
    expect(associationCandidates(data, '20', 10, [])).toEqual([20]);
    expect(associationCandidates(data, '100', 10, [])).toEqual([20]);
    expect(associationCandidates(data, 'blind', 10, [])).toEqual([30]);
  });
  it('excludes self and duplicate canonical or alias selections', () => {
    expect(associationCandidates(data, '', 10, [99])).toEqual([30]);
    expect(associationCandidates(data, 'scorch', 99, [])).toEqual([]);
    expect(associationCandidates(data, '', 10, [20, 30])).toEqual([]);
  });
  it('does not offer reserved global tooltips or archived tooltips', () => {
    const withExtras: EditorData = {
      ...data,
      items: {
        ...data.items,
        2: item(2, 'Tooltip 2'),
        3: item(3, 'Tooltip 3'),
        40: item(40, 'Gone'),
      },
      bundle: {
        ...data.bundle,
        tooltips: {
          40: {
            hash: 40,
            text: {},
            associated: [],
            archive: {
              removedAt: '2026-10-01T00:00:00.000Z',
              lastSeen: { name: 'Gone', categoryId: 'weapon-frame', manifestVersion: 'v1' },
            },
          },
        },
      },
    };
    expect(associationCandidates(withExtras, '', 10, [])).toEqual([30, 20]);
  });
  it('reorders without mutating input and leaves boundary moves unchanged', () => {
    const source = [20, 30, 40];
    expect(moveAssociation(source, 1, -1)).toEqual([30, 20, 40]);
    expect(moveAssociation(source, 1, 1)).toEqual([20, 40, 30]);
    expect(moveAssociation(source, 0, -1)).toEqual(source);
    expect(source).toEqual([20, 30, 40]);
  });
});
