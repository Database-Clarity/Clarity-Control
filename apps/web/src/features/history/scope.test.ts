import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { classifyRevision, englishScope, isRelevant, projectHistory, viewScope } from './scope';
import { revertDraft, restoreLegacyText } from './revert';

const stamp = { updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'a' };
const current: Tooltip = {
  hash: 1,
  associated: [2],
  text: {
    en: { text: 'Current', ...stamp },
    de: { text: 'Aktuell', ...stamp },
    fr: { text: 'Actuel', ...stamp },
  },
};
const old: Tooltip = {
  hash: 1,
  associated: [],
  text: {
    en: { text: 'Old', ...stamp },
    de: { text: 'Alt', ...stamp },
    fr: { text: 'Vieux', ...stamp },
  },
};
describe('history view scope', () => {
  it('classifies single-language, multilingual, shared-only, and initial/deleted revisions', () => {
    const german = { ...current, text: { ...current.text, de: old.text.de } };
    expect(classifyRevision(current, german)).toEqual({ languages: ['de'], fields: [] });
    expect(isRelevant(classifyRevision(current, german), englishScope)).toBe(false);
    expect(isRelevant(classifyRevision(current, german), viewScope('de', false))).toBe(true);
    expect(classifyRevision(current, old)).toEqual({
      languages: ['en', 'de', 'fr'],
      fields: ['associated'],
    });
    expect(classifyRevision(current, { ...current, associated: [] })).toEqual({
      languages: [],
      fields: ['associated'],
    });
    expect(isRelevant(classifyRevision(null, old), englishScope)).toBe(true);
    expect(isRelevant(classifyRevision(current, null), englishScope)).toBe(true);
  });
  it('projects both sides of comparison without hidden text or fields', () => {
    const scope = viewScope('de', true);
    const before = projectHistory(old, scope)!;
    const after = projectHistory(current, scope)!;
    expect(Object.keys(before.text)).toEqual(['en', 'de']);
    expect(Object.keys(after.text)).toEqual(['en', 'de']);
    expect(before.associated).toEqual(after.associated);
    expect(projectHistory(null, scope)).toBeNull();
  });
  it('restores English and shown fields while preserving German, French, and hidden metadata', () => {
    const result = revertDraft(current, old, { id: 1, login: 'a', role: 'editor' }, englishScope);
    expect(result.text.en).toEqual(old.text.en);
    expect(result.text.de).toEqual(current.text.de);
    expect(result.text.fr).toEqual(current.text.fr);
    expect(result.associated).toEqual(old.associated);
    expect(current.text.en?.text).toBe('Current');
  });
  it('intersects translator permissions with the shown language, always preserving English', () => {
    const result = revertDraft(
      current,
      old,
      { id: 1, login: 't', role: 'translator', languages: ['en', 'de', 'fr'] },
      viewScope('de', false),
    );
    expect(result.text.en).toEqual(current.text.en);
    expect(result.text.de).toEqual(old.text.de);
    expect(result.text.fr).toEqual(current.text.fr);
    expect(result.associated).toEqual(current.associated);
  });
  it('restores only legacy English text, preserving hidden languages and shared fields', () => {
    const result = restoreLegacyText(current, old, { id: 1, login: 'a', role: 'editor' }, true);
    expect(result.text.en).toEqual(old.text.en);
    expect(result.text.de).toEqual(current.text.de);
    expect(result.associated).toEqual(current.associated);
  });
});
