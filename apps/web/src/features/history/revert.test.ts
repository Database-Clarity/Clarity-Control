import { describe, expect, it } from 'vitest';
import { type Tooltip } from '@clarity/core';
import { revertDraft, restoreLegacyText } from './revert';
import { englishScope } from './scope';
import { uploadChanged } from './UploadRollback';

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
  it('restored translations keep the English revision they were written against', () => {
    const old: Tooltip = {
      hash: 123,
      text: {
        en: { text: 'Old', updatedAt: '2025-01-01T00:00:00Z', updatedBy: 'dan' },
        de: {
          text: 'Alt',
          updatedAt: '2025-01-02T00:00:00Z',
          updatedBy: 'eve',
          sourceUpdatedAt: '2024-12-01T00:00:00Z',
        },
        fr: { text: 'Ancien', updatedAt: '2025-01-02T00:00:00Z', updatedBy: 'eve' },
      },
      associated: [],
    };
    const manager = {
      id: 5,
      login: 'erin',
      role: 'translator' as const,
      languages: ['de', 'fr'] as ['de', 'fr'],
    };
    const scope = { languages: ['en', 'de'] as const, fields: [] };
    const scoped = revertDraft(current, old, manager, scope, true);
    expect(scoped.text.de?.sourceUpdatedAt).toBe('2024-12-01T00:00:00Z');
    expect(scoped.text.en).toEqual(current.text.en);
    // A legacy entry without a source: that revision's English.
    const whole = revertDraft(current, old, manager, undefined, true);
    expect(whole.text.fr?.sourceUpdatedAt).toBe('2025-01-01T00:00:00Z');
    // A rebased draft base copies the stored entry exactly.
    expect(revertDraft(current, old, manager).text.fr).toEqual(old.text.fr);
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

describe('upload rollback', () => {
  it('offers an upload only for /save commits that changed the language', () => {
    const message = 'Translate\n\nClarity-Changed: 123=de,fr;124=en,associations';
    expect(uploadChanged(message, 'de')).toBe(true);
    expect(uploadChanged(message, 'fr')).toBe(true);
    expect(uploadChanged(message, 'es')).toBe(false);
    expect(uploadChanged('Publish batch', 'de')).toBe(false);
    // Only the Worker-written final paragraph counts; a line in the person's message does not.
    const forged = 'Fix typo\n\nClarity-Changed: 125=fr\n\nClarity-Changed: 125=de;126=de';
    expect(uploadChanged(forged, 'de')).toBe(true);
    expect(uploadChanged(forged, 'fr')).toBe(false);
    expect(uploadChanged('Clarity-Changed: 1=de\n\nPlain message', 'de')).toBe(false);
  });
});
