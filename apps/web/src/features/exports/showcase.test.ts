import { expect, test } from 'vitest';
import {
  elementTagNames,
  markupSnippets,
  markupSymbols,
  markupTags,
  parseMarkup,
  showcaseGlobals,
  showcaseText,
} from '@clarity/core';
import { markupEntries } from '../editor/markupRow/entries';
import { helpRows } from '../editor/help/reference';

const excluded: Record<string, string> = {
  'decl-import': 'Imports need another document; this example has no external data dependencies.',
};
const coveredHelp: Record<string, RegExp> = {
  'list-dot': /^• /m,
  comment: /\/\/.*\n\/\*/,
  blank: /\n\n/,
  'var-empty': /^var optional = empty/m,
  math: /\$\{[^}]+\}/,
};

function missing(entries: readonly { id: string; usage?: RegExp }[]) {
  return entries
    .filter(({ id, usage }) => {
      if (excluded[id]) return false;
      const pattern = usage ?? coveredHelp[id];
      return !pattern || !new RegExp(pattern.source, pattern.flags).test(showcaseText);
    })
    .map(({ id }) => id);
}

test('showcase covers the core, markup row, completion, and help registries', () => {
  const entries = markupEntries({ variables: '', titles: '', allowBaseEnhanced: true });
  expect(missing([...markupSnippets, ...markupSymbols, ...markupTags, ...entries])).toEqual([]);
  expect(
    missing(
      helpRows()
        .filter((row) => !row.keys)
        .map((row) => ({
          id: row.id,
          usage: entries.find((entry) => entry.id === row.id)?.usage,
        })),
    ),
  ).toEqual([]);
  for (const element of elementTagNames)
    expect(showcaseText).toMatch(new RegExp(`<${element} [^<>]+ />`));
  expect(missing([{ id: 'synthetic-new-option', usage: /<new-option\/>/ }])).toEqual([
    'synthetic-new-option',
  ]);
  expect(missing([{ id: 'synthetic-new-option' }])).toEqual(['synthetic-new-option']);
});

test('standalone showcase parses with no diagnostics in base and enhanced previews', () => {
  for (const type of ['Weapon Trait', 'Weapon Trait Enhanced']) {
    const result = parseMarkup(showcaseText, { ...showcaseGlobals, type });
    expect(result.diagnostics).toEqual([]);
    expect(result.lines.length).toBeGreaterThan(30);
  }
});
