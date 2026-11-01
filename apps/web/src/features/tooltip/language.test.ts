import { describe, expect, it } from 'vitest';
import type { Lang } from '@clarity/core';
import type { User } from '../../services/api';
import { defaultLanguage, firstAssignedLanguage, withLanguage } from './language';

const translator: User = { id: 1, login: 't', role: 'translator', languages: ['de', 'fr'] };
const editor: User = { id: 2, login: 'e', role: 'editor', languages: ['ja'] };
const query = (value: string) => new URLSearchParams(value);

describe('default tooltip language', () => {
  it.each<[string, User | null, string, Lang | undefined, Lang]>([
    ['URL beats remembered choice and assignment', translator, '?lang=es', 'fr', 'es'],
    ['remembered choice beats assignment', translator, '', 'fr', 'fr'],
    ['first assigned language for a translator', translator, '', undefined, 'de'],
    [
      'invalid URL language falls through to the assignment',
      translator,
      '?lang=xx',
      undefined,
      'de',
    ],
    [
      'invalid URL language falls through to the remembered choice',
      translator,
      '?lang=',
      'fr',
      'fr',
    ],
    ['English for an editor even with languages listed', editor, '', undefined, 'en'],
    ['English when signed out', null, '', undefined, 'en'],
    [
      'English for a translator without assignments',
      { ...translator, languages: [] },
      '',
      undefined,
      'en',
    ],
    [
      'English for a translator with unset languages',
      { id: 3, login: 'x', role: 'translator' },
      '',
      undefined,
      'en',
    ],
    ['URL English is respected for a translator', translator, '?lang=en', undefined, 'en'],
  ])('%s', (_name, user, search, stored, expected) => {
    expect(defaultLanguage(user, query(search), stored)).toBe(expected);
  });
  it('only translators have an assigned language', () => {
    expect(firstAssignedLanguage(translator)).toBe('de');
    expect(firstAssignedLanguage(editor)).toBeUndefined();
    expect(firstAssignedLanguage(undefined)).toBeUndefined();
  });
});

describe('changing language', () => {
  it('preserves variant and line and does not mutate the current query', () => {
    const current = query('variant=11&line=4&lang=en');
    const next = withLanguage(current, 'de');
    expect(Object.fromEntries(next)).toEqual({ variant: '11', line: '4', lang: 'de' });
    expect(current.get('lang')).toBe('en');
  });
  it('adds lang when absent', () => {
    expect(withLanguage(query('line=2'), 'fr').toString()).toBe('line=2&lang=fr');
  });
});
