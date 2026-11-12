import { expect, test } from 'vitest';
import { parseMarkup, type Tooltip } from '@clarity/core';
import { tooltipImports } from './tooltipImports';
import type { Drafts } from './draftStorage';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' } },
  associated: [],
});

test('cached saved imports stay isolated from draft edits, removal, languages and new aliases', () => {
  const saved = { 10: tooltip(10, 'saved') };
  const aliases = { 20: { to: 10, kind: 'frame' as const } };
  const draft = (text: string) => ({ 10: { base: saved[10], next: tooltip(10, text) } });
  expect(tooltipImports(saved, draft('first'), 'en', aliases)[20]).toBe('first');
  expect(tooltipImports(saved, draft('second'), 'en', aliases)[20]).toBe('second');
  expect(tooltipImports(saved, {}, 'en', aliases)[20]).toBe('saved');
  expect(tooltipImports(saved, {}, 'de', aliases)[20]).toBe('');
  expect(tooltipImports(saved, {}, 'en', {})[20]).toBeUndefined();
  expect(tooltipImports({ 10: tooltip(10, 'new saved') }, {}, 'en', aliases)[20]).toBe('new saved');
});
test('editor and preview imports resolve aliases to canonical draft text, not stale alias drafts', () => {
  const imports = tooltipImports(
    { 10: tooltip(10, 'saved') },
    {
      10: { base: tooltip(10, 'saved'), next: tooltip(10, 'canonical draft') },
      20: { base: tooltip(20, 'old'), next: tooltip(20, 'stale alias draft') },
    },
    'en',
    { 20: { to: 10, kind: 'frame' }, 99: { to: 20, kind: 'sandbox' } },
  );
  expect(imports).toEqual({ 10: 'canonical draft', 20: 'canonical draft', 99: 'canonical draft' });
});

test('lookup-only imports match indexed aliases, draft snapshots, missing languages, and nested imports', () => {
  const saved = {
    1: tooltip(1, 'Global body'),
    2: tooltip(2, 'var amount = 10'),
    3: tooltip(3, 'title Detail (\nSaved title\n)'),
    10: tooltip(10, 'import main from 31\n#amount damage\n<title Info [Detail] />'),
    11: tooltip(11, '<pve Nested />'),
    40: tooltip(40, 'import main from 41'),
    41: tooltip(41, 'import main from 40'),
  };
  const aliases = {
    20: { to: 10, kind: 'frame' as const },
    30: { to: 20, kind: 'sandbox' as const },
    31: { to: 11, kind: 'name' as const },
  };
  const draft = (hash: keyof typeof saved, text: string) => ({
    base: saved[hash],
    next: tooltip(hash, text),
  });
  const snapshots: Drafts[] = [
    {},
    {
      2: draft(2, 'var amount = 20'),
      3: draft(3, 'title Detail (\nDraft title\n)'),
      11: draft(11, '<pvp Draft nested />'),
      20: { base: tooltip(20, 'stale'), next: tooltip(20, 'stale alias draft') },
      50: { base: tooltip(50, ''), next: tooltip(50, 'draft only') },
    },
    { 10: { base: saved[10], next: { ...saved[10], text: {} } } },
  ];
  for (const drafts of snapshots)
    for (const lang of ['en', 'de'] as const) {
      const indexed = tooltipImports(saved, drafts, lang, aliases);
      const lookup = tooltipImports(saved, drafts, lang, aliases, { lookupOnly: true });
      for (const key of [...Object.keys(indexed), '999', '01', 'bad', '1.1']) {
        expect(lookup[key], `${lang}:${key}`).toEqual(indexed[key]);
        expect(key in lookup).toBe(key in indexed);
      }
      const resolve = (imports: Record<string, string>, text: string) =>
        parseMarkup(text, {
          imports,
          variables: imports[2] ?? '',
          titles: imports[3] ?? '',
        });
      for (const text of [
        'import main from 30',
        'import main from 40',
        'import main from global',
        'title Ref (\nimport main from 31\n)\n<title Info [Ref] />',
      ]) {
        expect(resolve(lookup, text)).toEqual(resolve(indexed, text));
      }
      if (lang === 'en') {
        expect(JSON.stringify(resolve(lookup, 'import main from global'))).toContain('Global body');
        if (drafts === snapshots[1]) {
          const result = JSON.stringify(resolve(lookup, 'import main from 30'));
          expect(result).toContain('Draft nested');
          expect(result).toContain('20 damage');
          expect(result).toContain('Draft title');
          expect(result).not.toContain('stale alias draft');
        }
      }
    }
});

test('lookup-only resolution reads requested documents without enumerating the catalogue', () => {
  const saved = new Proxy(
    { 10: tooltip(10, 'saved') },
    {
      ownKeys() {
        throw Error('Unexpected catalogue enumeration');
      },
    },
  );
  const imports = tooltipImports(saved, {}, 'en', {}, { lookupOnly: true });
  expect(imports[10]).toBe('saved');
  expect(imports[99]).toBeUndefined();
});
