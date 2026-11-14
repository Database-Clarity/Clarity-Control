import { expect, it } from 'vitest';
import { compileTerms, matchTerms } from './match';
import { mergeGlossary, type TermList } from './termList';
import { computeDiagnostics, computeMissingTerms } from '../editor/diagnosticRequest';
const entry = {
  en: 'Jolt',
  term: 'Aufschrecken',
  forms: ['aufgeschreckt'],
  updatedAt: '2026-11-14T00:00:00Z',
  updatedBy: 'alice',
};

it('agreed Jolt overrides the in-game Jolted while keeping the secondary name', () => {
  const names: TermList = {
    id: 'de:names',
    lang: 'de',
    terms: [
      { en: 'Jolted', kind: 'keyword', official: ['Aufgeschreckt'] },
      { en: 'Voltshot', kind: 'name', official: ['Volt-Schuss'] },
    ],
  };
  const list = mergeGlossary(names, { v: 1, lang: 'de', terms: { jolt: entry } }, 'a');
  expect(list.terms[0]).toMatchObject({
    en: 'Jolt',
    official: ['Aufschrecken'],
    inGame: ['Aufgeschreckt'],
  });
  const found = matchTerms('Jolt JOLTED jolts', compileTerms(list.terms));
  expect(found.map((mark) => list.terms[mark.entry].glossary)).toEqual([entry, entry, entry]);
  expect(list.terms).toHaveLength(2);
});
it('reports missing terms in diagnostics, accepts forms, clears on empty text, and only warns', () => {
  const input = {
    text: 'Gegner',
    lang: 'de' as const,
    globals: { variables: '', titles: '', type: '' },
    requireEnglish: false,
    sourceText: 'Jolt',
    termCheck: { id: 'glossary-test', entries: [entry] },
  };
  expect(computeDiagnostics(input).missingTerms).toEqual(['Jolt']);
  expect(computeDiagnostics(input).issues.filter((issue) => issue.severity === 'error')).toEqual(
    [],
  );
  const byId = { ...input, termCheck: { id: 'glossary-test' } };
  expect(computeMissingTerms({ ...byId, text: 'AUFGESCHRECKTE Gegner' })).toEqual([]);
  expect(computeMissingTerms({ ...byId, text: '' })).toEqual([]);
  expect(computeMissingTerms({ ...byId, text: '#Aufschrecken\nGegner' })).toEqual(['Jolt']);
});
