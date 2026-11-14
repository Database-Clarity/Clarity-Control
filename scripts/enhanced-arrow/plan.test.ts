import { describe, expect, test } from 'vitest';
import { blobContent } from '../mult-write/rewrite.js';
import { checkHandRows, planBytes, planFile, planWrite, summary, type HandRow } from './plan';

const tooltip = (hash: number, text: string) =>
  blobContent({
    associated: [],
    hash,
    legacy: { inLiveDatabase: true, uploadToLive: false },
    text: { en: { text, updatedAt: '2025-01-01T00:00:00.000Z', updatedBy: 'Someone' } },
  });
const globals = { variables: '', titles: '' };
const hand: HandRow = {
  hash: 10,
  lang: 'en',
  before: 'var t = #e2',
  after: 'var t = <enhanced/>2',
};

describe('planFile', () => {
  test('changes only the text: updatedAt, updatedBy, and every other field stay', () => {
    const before = tooltip(10, 'Base.\nenhanced (\nvar t = #e2\n#e Faster.\n)');
    const change = planFile('tooltips/10.json', before, [hand], globals)!;
    const after = JSON.parse(change.after);
    expect(after.text.en.text).toBe(
      'Base.\nenhanced (\nvar t = <enhanced/>2\n<enhanced/> Faster.\n)',
    );
    expect(after.text.en.updatedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(after.text.en.updatedBy).toBe('Someone');
    expect({ ...after, text: undefined }).toEqual({ ...JSON.parse(before), text: undefined });
    expect(change.jsonLines).toHaveLength(1);
    expect(change.texts).toEqual([{ lang: 'en', lines: [3, 4], arrows: 1, hand: ['var t = #e2'] }]);
  });
  test('no arrow: no change, and non-canonical bytes are fine when untouched', () => {
    expect(
      planFile('tooltips/11.json', tooltip(11, 'Plain #element.'), [], globals),
    ).toBeUndefined();
    const loose = JSON.stringify(JSON.parse(tooltip(12, 'Plain.')));
    expect(planFile('tooltips/12.json', loose, [], globals)).toBeUndefined();
  });
  test('refuses non-canonical bytes it would rewrite, and hand rows that do not match once', () => {
    const loose = JSON.stringify(JSON.parse(tooltip(13, '#e Faster.')));
    expect(() => planFile('tooltips/13.json', loose, [], globals)).toThrow(/canonical/);
    expect(() =>
      planFile('tooltips/10.json', tooltip(10, 'No such line.'), [hand], globals),
    ).toThrow(/exactly one line/);
    expect(() =>
      planFile('tooltips/10.json', tooltip(10, 'var t = #e2\nvar t = #e2'), [hand], globals),
    ).toThrow(/exactly one line/);
    expect(() => planFile('tooltips/11.json', tooltip(11, 'var t = #e2'), [hand], globals)).toThrow(
      /foreign/,
    );
  });
  test('comments keep their #e (rewrite.ts rule)', () => {
    const change = planFile(
      'tooltips/14.json',
      tooltip(14, '#e Faster. // add #e later'),
      [],
      globals,
    )!;
    expect(JSON.parse(change.after).text.en.text).toBe('<enhanced/> Faster. // add #e later');
  });
});

describe('checkHandRows', () => {
  test('accepts only one #e<digit> made <enhanced/><digit>, English, one line', () => {
    expect(() => checkHandRows([hand])).not.toThrow();
    expect(() => checkHandRows([{ ...hand, after: 'var t = <enhanced/> 2' }])).toThrow(/after/);
    expect(() =>
      checkHandRows([{ ...hand, before: 'var t = #e', after: 'var t = <enhanced/>' }]),
    ).toThrow(/#e<digit>/);
    expect(() => checkHandRows([hand, hand])).toThrow(/duplicate/);
    expect(() => checkHandRows([{ ...hand, before: 'a\n#e2', after: 'a\n<enhanced/>2' }])).toThrow(
      /one line/,
    );
  });
});

describe('planWrite', () => {
  test('plans every file in order, is deterministic, and needs each hand row file', () => {
    const files: Record<string, string> = {
      'tooltips/10.json': tooltip(10, 'var t = #e2\n#e A.'),
      'tooltips/2.json': tooltip(2, 'var x = 1'),
      'tooltips/9.json': tooltip(9, 'Nothing.'),
    };
    const read = (path: string) => files[path];
    const plan = planWrite(Object.keys(files), read, [hand]);
    expect(plan.changes.map((change) => change.path)).toEqual(['tooltips/10.json']);
    expect(planBytes(planWrite(Object.keys(files).reverse(), read, [hand]))).toBe(planBytes(plan));
    expect(summary(plan)).toMatchObject({
      files: 1,
      texts: 1,
      arrows: 1,
      handRows: 1,
      jsonLines: 1,
    });
    expect(() => planWrite(['tooltips/9.json'], read, [hand])).toThrow(/file missing/);
  });
});
