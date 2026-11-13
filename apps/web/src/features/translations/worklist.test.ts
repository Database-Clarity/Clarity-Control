import { describe, expect, it } from 'vitest';
import type { User } from '../../services/api';
import { availableLanguages, entryPath, queuePath } from './worklist';

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
    expect(entryPath({ hash: 42, language: 'de' }, 42)).toBe('/t/42?lang=de');
    // An enhanced override is edited on its base's page; a plain link would redirect to the base.
    expect(entryPath({ hash: 43, language: 'de' }, 42)).toBe('/t/42?lang=de&variant=43');
  });

  it('returns to the Translations view the queue was opened from', () => {
    const context = { language: 'fr' as const, state: null, category: null, query: '' };
    expect(queuePath(context, user('translator', ['fr']))).toBe('/translations');
    expect(queuePath(context, user('translator', ['de', 'fr']))).toBe('/translations?lang=fr');
    expect(
      queuePath(
        { language: 'fr', state: 'outdated', category: 'perks', query: 'a b' },
        user('translator', ['fr']),
      ),
    ).toBe('/translations?cat=perks&q=a+b&state=outdated');
  });
});
