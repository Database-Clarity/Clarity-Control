import { describe, expect, it } from 'vitest';
import type { User } from '../../services/api';
import { editorAccess, type EditorAccessInput } from './access';

const ready: EditorAccessInput = {
  apiConfigured: true,
  hydrated: true,
  saving: false,
  user: { id: 1, login: 'e', role: 'editor' },
  lang: 'en',
};
const translator = (languages?: User['languages']): User => ({
  id: 2,
  login: 't',
  role: 'translator',
  languages,
});

describe('editor read-only reason', () => {
  it('is editable with a role for the language', () => {
    expect(editorAccess(ready)).toEqual({ reason: null });
    expect(editorAccess({ ...ready, user: translator(['de']), lang: 'de' })).toEqual({
      reason: null,
    });
  });
  it.each([
    ['no API', { apiConfigured: false }, /not connected to the save API/],
    ['drafts not loaded', { hydrated: false }, /loading your local drafts/],
    ['saving lock', { saving: true }, /open save review/],
    ['signed out', { user: null }, /sign in to edit/],
    ['no role', { user: { id: 3, login: 'n', role: null } }, /no editing role/],
  ] as const)('explains %s without a shortcut', (_name, patch, message) => {
    const access = editorAccess({ ...ready, ...patch });
    expect(access.reason).toMatch(message);
    expect(access.switchTo).toBeUndefined();
  });
  it('names the assigned languages and offers the first one to a translator on the wrong language', () => {
    expect(editorAccess({ ...ready, user: translator(['fr', 'de']), lang: 'en' })).toEqual({
      reason: 'Read-only: you can translate fr, de, not en.',
      switchTo: 'fr',
    });
  });
  it('reports a translator without assignments and offers no shortcut', () => {
    for (const languages of [undefined, []]) {
      const access = editorAccess({ ...ready, user: translator(languages) });
      expect(access.reason).toMatch(/no languages are assigned/);
      expect(access.switchTo).toBeUndefined();
    }
  });
  it('ranks the API, loading and saving causes before the role', () => {
    const wrongLang = { ...ready, user: translator(['de']) };
    expect(editorAccess({ ...wrongLang, saving: true }).switchTo).toBeUndefined();
    expect(editorAccess({ ...wrongLang, apiConfigured: false }).reason).toMatch(/save API/);
  });
});
