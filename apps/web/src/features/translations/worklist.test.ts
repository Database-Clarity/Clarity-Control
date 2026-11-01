import { describe, expect, it } from 'vitest';
import { translationQueue, type Tooltip } from '@clarity/core';
import type { User } from '../../services/api';
import {
  availableLanguages,
  countStates,
  entryLabel,
  entryPath,
  filterQueue,
  nextEntry,
  parseWorklistFilter,
} from './worklist';

const stamp = { updatedBy: 'x' };
function tooltip(hash: number, en: string, de?: { text: string; source?: string }): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: en, updatedAt: '2026-02-01T00:00:00.000Z', ...stamp },
      ...(de
        ? {
            de: {
              text: de.text,
              updatedAt: '2026-01-01T00:00:00.000Z',
              ...stamp,
              ...(de.source ? { sourceUpdatedAt: de.source } : {}),
            },
          }
        : {}),
    },
  };
}
const user = (role: User['role'], langs?: string[]) =>
  ({ login: 'u', role, languages: langs }) as unknown as User;

describe('worklist helpers', () => {
  const tooltips = [
    tooltip(1, 'Alpha'),
    tooltip(2, 'Beta', { text: 'Bravo', source: '2026-01-01T00:00:00.000Z' }),
    tooltip(3, 'Gamma', { text: 'Gamma de', source: '2026-02-01T00:00:00.000Z' }),
  ];
  const entries = translationQueue(tooltips, ['de']);
  const name = (t: Tooltip) => entryLabel(t, t.hash === 1 ? 'First Perk' : undefined);

  it('parses the filter and defaults unknown values to missing', () => {
    expect(['missing', 'outdated', 'all'].map(parseWorklistFilter)).toEqual([
      'missing',
      'outdated',
      'all',
    ]);
    expect([null, '', 'current', 'ALL'].map(parseWorklistFilter)).toEqual([
      'missing',
      'missing',
      'missing',
      'missing',
    ]);
  });

  it('limits translators to assigned languages and shows others everything but English', () => {
    expect(availableLanguages(user('translator', ['de', 'en', 'fr']))).toEqual(['de', 'fr']);
    expect(availableLanguages(user('translator', []))).toEqual([]);
    expect(availableLanguages(user('translator'))).toEqual([]);
    for (const other of [user('maintainer'), user('editor'), user('trial'), user(null), null]) {
      const all = availableLanguages(other);
      expect(all).toContain('de');
      expect(all).not.toContain('en');
    }
  });

  it('filters by state', () => {
    const states = (f: Parameters<typeof filterQueue>[1]) =>
      filterQueue(entries, f, '', name).map((e) => [e.tooltip.hash, e.state]);
    expect(states('missing')).toEqual([[1, 'missing']]);
    expect(states('outdated')).toEqual([[2, 'outdated']]);
    expect(states('all')).toEqual([
      [2, 'outdated'],
      [1, 'missing'],
      [3, 'current'],
    ]);
    expect(countStates(entries)).toEqual({ missing: 1, outdated: 1, current: 1 });
  });

  it('searches name, hash and saved text case-insensitively', () => {
    const hashes = (q: string) => filterQueue(entries, 'all', q, name).map((e) => e.tooltip.hash);
    expect(hashes('first perk')).toEqual([1]);
    expect(hashes(' 3 ')).toEqual([3]);
    expect(hashes('BRAVO')).toEqual([2]);
    expect(hashes('gamma')).toEqual([3]);
    expect(hashes('nothing')).toEqual([]);
    expect(hashes('')).toEqual([2, 1, 3]);
  });

  it('picks the first entry needing work and builds the language link', () => {
    expect(nextEntry(entries)?.tooltip.hash).toBe(2);
    expect(nextEntry(filterQueue(entries, 'all', 'gamma', name))).toBeNull();
    expect(nextEntry([])).toBeNull();
    expect(entryPath(entries[0])).toBe('/t/2?lang=de');
  });

  it('labels custom tooltips and falls back to the hash', () => {
    const custom = { ...tooltip(9, 'x'), custom: { name: 'Mine', categoryId: 'c' } };
    expect(entryLabel(custom, undefined)).toBe('Mine');
    expect(entryLabel(custom, 'Item')).toBe('Item');
    expect(entryLabel(tooltip(9, 'x'), undefined)).toBe('9');
  });
});
