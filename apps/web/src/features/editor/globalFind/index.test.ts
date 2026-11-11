import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { FindIndex, resultLimit, snippetFor, type FindEntry, type FindOptions } from './index';
const options: FindOptions = { search: 'cat', caseSensitive: false, wholeWord: false, raw: false };
const entry = (hash: number, text: string, categoryId = 'a'): FindEntry => ({
  hash,
  text,
  categoryId,
  category: categoryId,
  name: `Entry ${hash}`,
  lang: 'en',
});

describe('global text index', () => {
  it.each([
    { name: 'punctuation word boundaries', text: 'a(cat)b', search: '(cat)' },
    { name: 'escaped newline', text: 'a\nb', search: String.raw`a\nb` },
    { name: 'escaped tab', text: 'a\tb', search: String.raw`a\tb` },
    { name: 'escaped backslash', text: String.raw`C:\new`, search: String.raw`C:\\new` },
    { name: 'decomposed query', text: 'café', search: 'cafe\u0301' },
    { name: 'decomposed document', text: 'cafe\u0301', search: 'café' },
    { name: 'Unicode compatibility', text: 'Kelvin KELVIN kelvin', search: 'kelvin' },
    { name: 'Unicode word categories', text: '𐐀cat𐐀 cat', search: 'cat' },
    { name: 'CRLF document offsets', text: 'foo\r\ncat', search: 'cat' },
  ])('preserves widget parity for $name', ({ text, search }) => {
    const state = EditorState.create({ doc: text });
    const index = new FindIndex();
    index.update([entry(1, text)]);
    for (const caseSensitive of [false, true])
      for (const wholeWord of [false, true]) {
        const query = new SearchQuery({ search, caseSensitive, wholeWord });
        const expected: { from: number; to: number }[] = [];
        const cursor = query.getCursor(state);
        for (let next = cursor.next(); !next.done; next = cursor.next())
          expected.push({ from: next.value.from, to: next.value.to });
        for (const raw of [false, true]) {
          const results = index.query({ search, caseSensitive, wholeWord, raw }).results;
          expect(results.map(({ from, to }) => ({ from, to }))).toEqual(expected);
          for (const result of results)
            expect(result.matched).toBe(state.doc.sliceString(result.from, result.to));
        }
      }
  });
  it('bounds snippets at words, indicates omitted context, and collapses masked tags', () => {
    const text = 'beginning '.repeat(15) + 'before cat after ' + 'continuation '.repeat(20);
    const from = text.indexOf('cat');
    const snippet = snippetFor(text, from, from + 3);
    expect(snippet.snippet).toMatch(/^…beginning .*continuation…$/);
    expect(snippet.snippet.slice(snippet.markFrom, snippet.markTo)).toBe('cat');
    expect(snippetFor('• \0\0\0 cat \0\0 end', 6, 9).snippet).toBe('• cat end');
    expect(snippetFor('x'.repeat(10000) + 'cat' + 'y'.repeat(10000), 10000, 10003).snippet).toBe(
      '…cat…',
    );
  });
  it('matches case and Unicode whole words, with exact authored offsets', () => {
    const index = new FindIndex();
    index.update([entry(1, 'Cat cat cats écat caté\ncat')]);
    expect(index.query(options).results).toHaveLength(6);
    expect(index.query({ ...options, wholeWord: true }).results.map((match) => match.from)).toEqual(
      [0, 4, 23],
    );
    expect(
      index
        .query({ ...options, caseSensitive: true, wholeWord: true })
        .results.map((match) => match.from),
    ).toEqual([4, 23]);
  });
  it('excludes tags, including multiline tags, unless raw, preserving line and selection offsets', () => {
    const index = new FindIndex();
    const text = '<color\ncat>cat</color>';
    index.update([entry(1, text)]);
    const result = index.query(options).results;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ from: 11, to: 14, line: 2, matched: 'cat' });
    expect(index.query({ ...options, raw: true }).results).toHaveLength(2);
    expect(index.query({ ...options, search: 'color' }).results).toHaveLength(0);
    expect(index.query({ ...options, search: String.raw`\n` }).results).toHaveLength(0);
  });
  it('filters category, overlays changed and empty drafts, and removes discarded entries', () => {
    const index = new FindIndex();
    index.update([entry(1, 'cat'), entry(2, 'cat', 'b')]);
    expect(
      index.query({ ...options, categoryId: 'a' }).results.map((result) => result.hash),
    ).toEqual([1]);
    index.update([entry(1, ''), entry(3, 'cat')], [2]);
    expect(index.query(options).results.map((result) => result.hash)).toEqual([3]);
  });
  it('treats regex characters literally and bounds result transfer and DOM size', () => {
    const index = new FindIndex();
    index.update([entry(1, '[cat] '.repeat(resultLimit + 1))]);
    const result = index.query({ ...options, search: '[cat]' });
    expect(result.results).toHaveLength(resultLimit);
    expect(result.capped).toBe(true);
    expect(
      result.results[0].snippet.slice(result.results[0].markFrom, result.results[0].markTo),
    ).toBe('[cat]');
  });
});
