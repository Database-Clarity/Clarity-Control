import { describe, expect, it } from 'vitest';
import { type Tooltip } from '@clarity/core';
import { revertDraft, restoreLegacyText } from './revert';
import { englishScope } from './scope';

const current: Tooltip = {
  hash: 123,
  text: {
    en: { text: 'Current', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' },
    de: { text: 'Aktuell', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'bob' },
    fr: { text: 'Courant', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'carol' },
  },
  associated: [456],
};
const version: Tooltip = {
  hash: 123,
  text: { en: { text: 'Old', updatedAt: '2025-01-01T00:00:00Z', updatedBy: 'dan' } },
  associated: [],
};
describe('history draft restoration', () => {
  it('restores legacy text while preserving every non-text field', () => {
    const rich: Tooltip = {
      ...current,
      custom: { name: 'Custom', categoryId: 'weapon-mod' },
      bungieSnapshot: { description: 'Snapshot', snapshotAt: '2026-10-01T00:00:00Z' },
      compendium: {
        gid: '1',
        rowKey: 'row',
        snapshot: { plain: '', runs: [] },
        snapshotAt: '2026-10-01T00:00:00Z',
      },
      archive: {
        removedAt: '2026-10-01T00:00:00Z',
        lastSeen: { name: 'Old name', categoryId: 'weapon-mod', manifestVersion: 'pinned' },
        note: 'Keep',
      },
      legacy: { uploadedBy: 'owner' },
    };
    const result = restoreLegacyText(
      rich,
      version,
      { id: 1, login: 'alice', role: 'editor' },
      true,
    );
    expect({ ...result, text: {} }).toEqual({ ...rich, text: {} });
    expect(result.text.en?.text).toBe('Old');
    expect(result.text.de).toEqual(rich.text.de);
    expect(rich.text.de).toBeDefined();
  });
  it('limits legacy restore to assigned languages and verified identities', () => {
    const user = { id: 2, login: 'bob', role: 'translator' as const, languages: ['de' as const] };
    const result = restoreLegacyText(current, version, user, true);
    expect(result.text.en).toEqual(current.text.en);
    expect(result.text.de).toEqual(current.text.de);
    expect(result.associated).toEqual(current.associated);
    expect(() => restoreLegacyText(current, version, user, false)).toThrow('not verified');
    expect(() => restoreLegacyText(current, version, { ...user, role: null }, true)).toThrow(
      'permission',
    );
    expect(() => restoreLegacyText(current, { ...version, hash: 456 }, user, true)).toThrow(
      'different tooltip',
    );
  });
  it('restores English and shown fields without changing hidden languages', () => {
    const result = revertDraft(
      current,
      version,
      { id: 1, login: 'alice', role: 'editor' },
      englishScope,
    );
    expect(result).toEqual({ ...version, text: { ...current.text, en: version.text.en } });
    expect(result).not.toBe(version);
    expect(current.associated).toEqual([456]);
  });
  it('restores only assigned translator languages, including absent historical text', () => {
    const result = revertDraft(
      current,
      version,
      {
        id: 2,
        login: 'bob',
        role: 'translator',
        languages: ['de'],
      },
      { languages: ['en', 'de'], fields: ['associated'] },
    );
    expect(result.text.de).toBeUndefined();
    expect(result.text.en).toEqual(current.text.en);
    expect(result.text.fr).toEqual(current.text.fr);
    expect(result.associated).toEqual(current.associated);
  });
  it('rejects users without permissions and versions for another hash', () => {
    expect(() => revertDraft(current, version, { id: 1, login: 'x', role: null })).toThrow(
      'permission',
    );
    expect(() =>
      revertDraft(current, { ...version, hash: 456 }, { id: 1, login: 'x', role: 'editor' }),
    ).toThrow('different tooltip');
  });
});
