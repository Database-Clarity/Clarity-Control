import { describe, expect, it } from 'vitest';
import type { EditorData } from '../../stores/data';
import { associationCandidates, moveAssociation } from './associations';

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
