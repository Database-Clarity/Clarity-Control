import { expect, test } from 'vitest';
import { parseMarkup } from './parse.js';
import { lowerConsumerMarkup } from './braces.js';
import { expandSnippet, markupSnippets, markupTags } from './snippets.js';
import { applyRetiredEdits, findRetiredMarkup, fixAllRetired } from '../validation/retired.js';

test.each([
  '<yellow Gjallarhorn />',
  '<yellow 30%<arrow/>33% />',
  '<yellow/>Line',
  'var name = <yellow Exotic />\n#name',
  'title Name (\n<yellow Exotic />\n)\n<title See [Name] />',
  '< table wide >\n|<yellow Exotic />\n<$>',
])('exotic renders and lowers exactly as its yellow alias: %s', (old) => {
  const next = old.replaceAll('<yellow', '<exotic');
  expect(parseMarkup(next)).toEqual(parseMarkup(old));
  expect(lowerConsumerMarkup(next)).toBe(lowerConsumerMarkup(old));
  expect(lowerConsumerMarkup(lowerConsumerMarkup(next))).toBe(lowerConsumerMarkup(next));
});

test('deprecated aliases offer keyword-only fixes, preserving comments and body bytes', () => {
  const old = '<yel/* keep */low Gjallarhorn />\nexport hidden Bonus (\nText\n)';
  const occurrences = findRetiredMarkup(old);
  expect(occurrences.map((item) => item.name)).toEqual(['yellow', 'export hidden']);
  expect(occurrences.every((item) => item.fixes.length === 1)).toBe(true);
  const next = fixAllRetired(old).text;
  expect(next).toBe('<exotic/* keep */ Gjallarhorn />\nexport Bonus (\nText\n)');
  expect(findRetiredMarkup(next)).toEqual([]);
  const alias = '<yellow Gjallarhorn />';
  const occurrence = findRetiredMarkup(alias)[0]!;
  expect(parseMarkup(applyRetiredEdits(alias, occurrence.fixes[0]!.edits))).toEqual(
    parseMarkup(alias),
  );
  expect(findRetiredMarkup('// <yellow note />\n/* export hidden X ( */')).toEqual([]);
});

test('the built-in catalogue follows the owner decisions', () => {
  const ids = markupSnippets.map((snippet) => snippet.id);
  for (const id of [
    'arrow-values',
    'enhanced-arrow',
    'title-ref',
    'link-ref',
    'wrap:bold',
    'wrap:yellow',
    'decl-export-hidden',
  ])
    expect(ids).not.toContain(id);
  const expand = (id: string) =>
    expandSnippet(markupSnippets.find((snippet) => snippet.id === id)!);
  const pair = expand('pair');
  expect(pair.text).toBe('<pve [?] /> <pvp [?] />');
  expect(pair.stops.map(({ from, to }) => pair.text.slice(from, to))).toEqual(['?', '?']);
  expect(expand('enhanced-block').text).toBe('enhanced (\n<enhanced/> \n)');
  expect(expand('icon-word').text).toBe('<solar Solar />');
  expect(expand('decl-import').text).toBe('import main from hash');
  expect(expand('editor-note').text).toBe('// note');
  expect(markupTags.some((tag) => tag.id === 'tag:yellow')).toBe(false);
  expect(markupTags.some((tag) => tag.id === 'tag:exotic')).toBe(true);
});
