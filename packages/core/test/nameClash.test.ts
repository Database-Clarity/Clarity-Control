import { describe, expect, test } from 'vitest';
import {
  findGlobalNameClashes,
  markupDefinitions,
  parseMarkup,
  validateGlobalAdditions,
  validateText,
  validateTooltip,
  type Tooltip,
} from '../src/index.js';

const globals = {
  variables: 'var range = 5\nvar empty1 = empty',
  titles: 'title Details (\nglobal body\n)',
};

function tooltip(hash: number, text: Record<string, string>): Tooltip {
  return {
    hash,
    text: Object.fromEntries(
      Object.entries(text).map(([lang, value]) => [
        lang,
        { text: value, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'x' },
      ]),
    ),
    associated: [],
  } as Tooltip;
}

describe('local definitions that clash with a global', () => {
  test('a local variable with a global name is an error at the name, naming the global', () => {
    const text = 'intro\nvar range = 9\n#range';
    const issues = validateText(text, 'en', globals);
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringMatching(/^#range is already a global variable .*rename it/),
        from: text.indexOf('range ='),
        to: text.indexOf('range =') + 'range'.length,
      }),
    ]);
  });

  test('a local title with a global name is an error', () => {
    const text = 'title Details (\nlocal\n)\n<title x [Details] />';
    const clash = validateText(text, 'en', globals).find((issue) => issue.severity === 'error');
    expect(clash?.message).toMatch(/Title "Details" is already a global title/);
    expect(text.slice(clash!.from, clash!.to)).toBe('Details');
  });

  test('every clashing definition is reported, an empty global counts, new names do not', () => {
    const text = 'var range = 1\nvar empty1 = 2\nvar fresh = 3\nvar range = 4';
    const errors = validateText(text, 'en', globals).filter((issue) => issue.severity === 'error');
    expect(errors.map((issue) => text.slice(issue.from, issue.to))).toEqual([
      'range',
      'empty1',
      'range',
    ]);
  });

  test('matching is exact: case and spacing differences are different names', () => {
    const text = 'var Range = 1\ntitle details (\nx\n)\ntitle Det ails (\ny\n)';
    expect(findGlobalNameClashes(text, globals)).toEqual([]);
  });

  test('references are never definitions', () => {
    const text = '#range and <title x [Details] /> and // var range = 3';
    expect(validateText(text, 'en', globals).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
  });

  test('commented-out titles are ignored, like the converter', () => {
    const text = '// title Details (\n// x\n// )\n/* title Details (\nx\n) */';
    expect(markupDefinitions(text).filter((definition) => definition.kind === 'title')).toEqual([]);
  });

  test('offsets point at the original text even after CRLF and comments', () => {
    const text = '// note\r\n/* c */\r\ntitle Details (\r\nbody\r\n)';
    const [clash] = findGlobalNameClashes(text, globals);
    expect(text.slice(clash.from, clash.to)).toBe('Details');
  });

  test('the global documents themselves are not flagged', () => {
    expect(validateText(globals.variables, 'en', globals, false, 2)).toEqual([]);
    expect(validateText(globals.titles, 'en', globals, false, 3)).toEqual([]);
  });

  test('the parser still lets the global win, so nothing else changes', () => {
    expect(parseMarkup('var range = 9\n#range', globals).diagnostics).toEqual([]);
  });

  test('validateTooltip flags the clash in each language independently', () => {
    const issues = validateTooltip(tooltip(10, { en: 'ok', de: 'var range = 1' }), () => globals);
    expect(issues).toEqual([expect.objectContaining({ severity: 'error', lang: 'de', hash: 10 })]);
  });

  test('the global in another language does not clash', () => {
    const issues = validateTooltip(tooltip(10, { en: 'ok', de: 'var range = 1' }), (lang) =>
      lang === 'de' ? { variables: '', titles: '' } : globals,
    );
    expect(issues).toEqual([]);
  });
});

describe('creating or renaming a global', () => {
  const tooltips = {
    '10': tooltip(10, { en: 'var range = 1', de: 'var other = 1' }),
    '11': tooltip(11, { en: 'title Panel (\nx\n)\nvar range = 3' }),
    '12': tooltip(12, { en: '#range' }),
  };

  test('a new global variable used locally is blocked and lists the tooltips', () => {
    const base = tooltip(2, { en: 'var other = 1' });
    const next = tooltip(2, { en: 'var other = 1\nvar range = 5' });
    const issues = validateGlobalAdditions({ base, next }, tooltips);
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        hash: 2,
        lang: 'en',
        message: expect.stringContaining('tooltips 10, 11'),
      }),
    ]);
    expect(next.text.en!.text.slice(issues[0].from, issues[0].to)).toBe('range');
  });

  test('renaming a global to a locally used name is blocked, per language', () => {
    const base = tooltip(2, { en: 'var a = 1', de: 'var a = 1' });
    const next = tooltip(2, { en: 'var a = 1', de: 'var range = 1' });
    expect(validateGlobalAdditions({ base, next }, tooltips)).toEqual([]);
    const other = tooltip(2, { en: 'var a = 1', de: 'var other = 1' });
    const issues = validateGlobalAdditions({ base, next: other }, tooltips);
    expect(issues).toEqual([
      expect.objectContaining({ lang: 'de', message: expect.stringContaining('tooltip 10') }),
    ]);
  });

  test('a new global title is checked against local titles', () => {
    const next = tooltip(3, { en: 'title Panel (\nbody\n)' });
    const issues = validateGlobalAdditions({ base: null, next }, tooltips);
    expect(issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining('Title "Panel"') }),
    ]);
  });

  test('already existing globals stay editable and unused names pass', () => {
    const base = tooltip(2, { en: 'var range = 5' });
    expect(
      validateGlobalAdditions({ base, next: tooltip(2, { en: 'var range = 6' }) }, tooltips),
    ).toEqual([]);
    expect(
      validateGlobalAdditions(
        { base, next: tooltip(2, { en: 'var range = 5\nvar free = 1' }) },
        tooltips,
      ),
    ).toEqual([]);
  });

  test('other tooltips are not affected', () => {
    expect(
      validateGlobalAdditions({ base: null, next: tooltip(10, { en: 'var range = 1' }) }, tooltips),
    ).toEqual([]);
  });
});
