import { expect, test } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { tooltipImports } from './tooltipImports';

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
