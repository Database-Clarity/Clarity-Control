import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { changeMarks, changedFields, changedSummary } from './changedFields';

const stamp = { updatedAt: '2026-06-01T00:00:00Z', updatedBy: 'a' };
const tooltip = (text: Tooltip['text'], associated: number[] = []): Tooltip => ({
  hash: 1,
  text,
  associated,
});

describe('changed fields', () => {
  const live = tooltip({ en: { text: 'Old', ...stamp }, de: { text: 'Alt', ...stamp } }, [1]);

  it('names only the languages whose text differs', () => {
    const current = tooltip({ en: { text: 'New', ...stamp }, de: { text: 'Alt', ...stamp } }, [1]);
    const fields = changedFields(live, current);
    expect(fields).toEqual({ text: ['en'], associations: false, custom: false });
    expect(changedSummary(fields)).toBe('English text');
  });

  it('lists associations and other languages separately', () => {
    const current = tooltip({ en: { text: 'Old', ...stamp }, de: { text: 'Neu', ...stamp } }, [2]);
    const fields = changedFields(live, current);
    expect(changedSummary(fields)).toBe('German text · Associations');
  });

  it('treats metadata-only edits as unchanged', () => {
    const current = tooltip(
      { en: { text: 'Old', updatedAt: '2030-01-01T00:00:00Z', updatedBy: 'z' }, de: live.text.de! },
      [1],
    );
    expect(changedSummary(changedFields(live, current))).toBe('');
  });

  it('counts every saved language as changed when there is no live version', () => {
    expect(changedFields(null, live).text).toEqual(['en', 'de']);
  });

  it('marks rows by what changed, with New and Alias independent of the live version', () => {
    const fields = changedFields(live, tooltip({ en: { text: 'New', ...stamp }, de: live.text.de! }, [2]));
    expect(changeMarks(fields, { isNew: false, markerOnly: false })).toEqual(['Text', 'Assoc']);
    expect(changeMarks(undefined, { isNew: false, markerOnly: false })).toEqual([]);
    expect(changeMarks(undefined, { isNew: true, markerOnly: false })).toEqual(['New']);
    expect(changeMarks(undefined, { isNew: false, markerOnly: true })).toEqual(['Alias']);
  });
});
