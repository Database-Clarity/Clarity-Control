import { describe, expect, it } from 'vitest';
import { FindIndex, resultLimit, type FindEntry, type FindOptions } from './index';
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
