import { describe, expect, it } from 'vitest';
import type { User } from '../../services/api';
import { availableLanguages, entryPath } from './worklist';

const user = (role: User['role'], langs?: string[]) =>
  ({ login: 'u', role, languages: langs }) as unknown as User;

describe('worklist helpers', () => {
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

  it('opens the editor in translate mode for the language', () => {
    expect(entryPath({ hash: 42, language: 'pt-br' })).toBe('/t/42?lang=pt-br');
  });
});
