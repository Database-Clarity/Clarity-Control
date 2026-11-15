import { describe, expect, it } from 'vitest';
import { validateText, validateTextWithReads, validateTooltip } from './index.js';
import { reservedMarkerMessage } from '../markup/parse.js';
import { gluedNumberIssues, gluedNumberMessage } from './numbers.js';
import { tooltipSchema } from '../schemas.js';

const globals = {
  variables: 'var damage = 10',
  titles: 'title Known (\nA title\n)',
  imports: { '123': 'Imported text', '456': 'Imported text' },
};

describe('whole numbers (owner decision 15-11)', () => {
  it.each([
    '1.#{g}',
    '#{g}.5',
    '#{g},000',
    '#{g}0',
    '1#g',
    '${#g}0',
    '1.${#{g}}',
    '${1.#{g}}',
    '#{=1}.5',
    '1#{=1}',
    '#{g}0\nimport g from 100',
    '1/* x */#{g}',
    '5/* x */\n#{g}',
    '1\r#{g}',
    '#{=1}#{=2}',
    '#{=1}.${#g * 2}',
    '${#g * 2},#{=1}',
    '${#g * 2}${#g * 2}',
  ])('refuses a glued reference in English and translations: %s', (text) => {
    const revision = { updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 'author' };
    for (const lang of ['en', 'de'] as const) {
      expect(validateText(text, lang, globals)).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'glued-number',
          message: gluedNumberMessage,
        }),
      );
      // Stored history remains readable; write validation refuses this content.
      const item = { hash: 42, associated: [], text: { [lang]: { ...revision, text } } };
      const result = tooltipSchema.safeParse(item);
      expect(result.success).toBe(true);
      expect(validateTooltip(item, () => globals, item)).toContainEqual(
        expect.objectContaining({ lang, severity: 'error', code: 'glued-number' }),
      );
    }
  });
  it.each([
    '1.5 1,000 #{g} #{=1} ${#g * 2}',
    'var g = 1.5\n#{g}',
    '#{g}. Next sentence.',
    '1, #{g}',
    '#{g}% x#{g}',
    'https://docs.google.com/sheets/278#gid=278',
    '<link sheet [https://docs.google.com/sheets/278#gid=278] />',
    '#{=1} ${#g * 2}',
    '#e#{=1}',
    '#{=1}#{g}',
  ])('keeps whole values, punctuation, and URLs valid: %s', (text) => {
    expect(gluedNumberIssues(text)).toEqual([]);
  });
  it('still accepts the arrow beside maths in live tooltip 2048641572', () => {
    expect(gluedNumberIssues('Volatile Rounds for #e${4.5+#d} seconds')).toEqual([]);
  });
  it('reports the authored reference range', () => {
    expect(gluedNumberIssues('Value 1.#{g}.')).toEqual([
      { severity: 'error', code: 'glued-number', message: gluedNumberMessage, from: 8, to: 12 },
    ]);
  });
  it('refuses astral digits across one separator and keeps non-digit text valid', () => {
    for (const text of ['𝟙.#{g}', '#{g}.𝟝', '𝟙,#{g}', '#{g},𝟝']) {
      const from = text.indexOf('#{g}');
      expect(gluedNumberIssues(text)).toEqual([
        {
          severity: 'error',
          code: 'glued-number',
          message: gluedNumberMessage,
          from,
          to: from + '#{g}'.length,
        },
      ]);
    }
    expect(gluedNumberIssues('ab.#{g}')).toEqual([]);
  });
  it.each(['Value 1/* x */#{g}.', 'Value 5/* x */\n#{g}.', 'Value 1\r#{g}.'])(
    'maps comment-stripped joins back to the authored reference: %s',
    (text) => {
      const from = text.indexOf('#{g}');
      expect(gluedNumberIssues(text)).toEqual([
        {
          severity: 'error',
          code: 'glued-number',
          message: gluedNumberMessage,
          from,
          to: from + '#{g}'.length,
        },
      ]);
    },
  );
  it.each([
    '#{=1} Schaden. #x #x0\nvar x = 1',
    '#{=1} Schaden. #g #g0',
    '#{=1} Schaden. #{x} #x0\nvar x = 1',
  ])('refuses plain digit suffixes identically without global context: %s', (text) => {
    expect(validateText(text, 'de', { variables: 'var g = 1', titles: '' })).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'glued-number' }),
    );
    expect(gluedNumberIssues(text)).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'glued-number' }),
    );
    expect(
      tooltipSchema.safeParse({
        hash: 42,
        associated: [],
        text: {
          de: { text, updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 'author' },
        },
      }).success,
    ).toBe(true);
  });
  it.each(['#x0\nvar x0 = 1', '#{g0}', '#{g} 0'])(
    'accepts exact local names and separated braced globals: %s',
    (text) => expect(gluedNumberIssues(text)).toEqual([]),
  );
});

describe('save validation', () => {
  it('blocks empty English, but not an empty translation or declaration library', () => {
    expect(validateText('  ', 'en')[0].severity).toBe('error');
    expect(validateText('', 'fr')).toEqual([]);
    expect(validateTooltip({ hash: 2, text: {}, associated: [] }, () => globals)).toEqual([]);
    expect(validateTooltip({ hash: 10, text: {}, associated: [] }, () => globals)).toMatchObject([
      { hash: 10, lang: 'en', severity: 'error' },
    ]);
  });
  it('warns about unknown variables/titles and supplies source ranges', () => {
    const text = '#damage #missing <title label [Unknown] />';
    const issues = validateText(text, 'en', globals);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      severity: 'warning',
      from: 8,
      to: 16,
      message: 'Unknown variable #missing.',
    });
    expect(issues[1].message).toContain('Unknown title');
    expect(validateText('#damage <title label [Known] />', 'en', globals)).toEqual([]);
  });
  it('blocks unknown imports but accepts aliases projected in the imports catalog', () => {
    expect(validateText('import main from 999', 'en', globals)).toMatchObject([
      { severity: 'error', message: 'Unresolved import "main" from 999.' },
    ]);
    expect(validateText('import main from 456', 'en', globals)).toEqual([]);
  });
  it('preserves parser errors and ignores commented-out unknown references', () => {
    expect(validateText('import self', 'en', globals)[0].severity).toBe('error');
    expect(validateText('// #missing <title label [Unknown] />\nText', 'en', globals)).toEqual([]);
  });
  it('detects errors in every stored language, not only the active editor language', () => {
    const revision = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a' };
    expect(
      validateTooltip(
        {
          hash: 20,
          associated: [],
          text: { en: { ...revision, text: 'Fine' }, fr: { ...revision, text: 'import self' } },
        },
        () => globals,
      ),
    ).toMatchObject([{ hash: 20, lang: 'fr', severity: 'error' }]);
  });
});

describe('validateTooltip scoped to a base', () => {
  const revision = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a' };
  const entry = (text: string) => ({ ...revision, text });
  const bad = 'import main from 999';
  const globalsFor = () => globals;

  it('lists errors in unchanged text as warnings and skips unwritten English', () => {
    const base = { hash: 10, text: { fr: entry(bad) }, associated: [] } as never;
    const next = { hash: 10, text: { fr: entry(bad) }, associated: [1] } as never;
    const issues = validateTooltip(next, globalsFor, base);
    expect(issues).toEqual([expect.objectContaining({ lang: 'fr', severity: 'warning' })]);
  });
  it('keeps errors for edited text and for a new tooltip', () => {
    const base = { hash: 10, text: { en: entry('ok') }, associated: [] } as never;
    const next = { hash: 10, text: { en: entry(bad) }, associated: [] } as never;
    expect(validateTooltip(next, globalsFor, base)).toMatchObject([{ severity: 'error' }]);
    expect(validateTooltip(next, globalsFor, null)).toMatchObject([{ severity: 'error' }]);
    expect(validateTooltip(next, globalsFor)).toMatchObject([{ severity: 'error' }]);
  });
  it('blocks editing English to empty but not leaving it empty', () => {
    const filled = { hash: 10, text: { en: entry('ok') }, associated: [] } as never;
    const empty = { hash: 10, text: {}, associated: [] } as never;
    expect(validateTooltip(empty, globalsFor, filled)).toMatchObject([
      { severity: 'error', lang: 'en' },
    ]);
    expect(validateTooltip(empty, globalsFor, empty)).toEqual([]);
  });
});

describe('validateTooltip with an unedited text that uses something the save changes', () => {
  const revision = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a' };
  const tooltip = {
    hash: 10,
    text: { fr: { ...revision, text: 'import main from 999' } },
    associated: [],
  } as never;

  it('keeps the error, with the reason, when recorded reads identify a changed input', () => {
    expect(
      validateTooltip(tooltip, () => globals, tooltip, {
        aliases: {},
        affectedBy: () => '"Donor" (124)',
      }),
    ).toMatchObject([
      {
        severity: 'error',
        message: expect.stringContaining('uses "Donor" (124), which this save changes'),
      },
    ]);
  });
  it('only warns without a save context, or when no recorded input changes', () => {
    expect(validateTooltip(tooltip, () => globals, tooltip)).toMatchObject([
      { severity: 'warning' },
    ]);
    expect(
      validateTooltip(tooltip, () => globals, tooltip, {
        aliases: {},
        affectedBy: () => undefined,
      }),
    ).toMatchObject([{ severity: 'warning' }]);
  });
});

describe('recorded validation reads', () => {
  it('records alias keys, missing imports, from global, and global title imports in their language', () => {
    const catalog = { '456': 'Shared', '1': 'Global' };
    const recorded = validateTextWithReads(
      'import main from 456\nimport main from global',
      'fr',
      { variables: '', titles: 'title Unused (\nimport x from 999\n)', imports: catalog },
      false,
      10,
      { 456: { to: 123, kind: 'sandbox' } },
    );
    expect(recorded.reads.lang).toBe('fr');
    expect([...recorded.reads.imports]).toEqual(
      expect.arrayContaining([
        ['456', 123],
        ['global', 1],
        ['1', 1],
        ['999', 999],
      ]),
    );
    expect(recorded.issues).toEqual(
      validateText(
        'import main from 456\nimport main from global',
        'fr',
        { variables: '', titles: 'title Unused (\nimport x from 999\n)', imports: catalog },
        false,
        10,
      ),
    );
  });
  it.each([
    'enhanced (\nx\n)\ntitle T (\n#fo#eo\n)',
    'title T (\n#foimport x from 5\nimport x from 5\n)',
  ])('observes synthesized variable lookups without changing diagnostics: %s', (text) => {
    const globals = {
      variables: 'var foo = import y from 9',
      titles: '',
      imports: { '5': 'export hidden x (\no\n)', '9': 'No exports' },
    };
    const recorded = validateTextWithReads(text, 'en', globals, false, 10, {});
    expect([...recorded.reads.variables]).toContain('foo');
    expect(recorded.reads.imports.has('9')).toBe(true);
    expect(recorded.issues).toEqual(validateText(text, 'en', globals, false, 10));
  });
  it('records missing variable names and local declarations even without a reference', () => {
    const recorded = validateTextWithReads(
      'var local = Value\n#missing',
      'en',
      { variables: '', titles: '' },
      false,
      10,
      {},
    );
    expect([...recorded.reads.variables]).toEqual(expect.arrayContaining(['missing', 'local']));
  });
});

describe('element-tagged text (hold lifted: every exporter lowers it)', () => {
  it('tagged spans in any language, in titles and translations, validate clean', () => {
    for (const [text, lang] of [
      ['Gain <solar Scorch /> and <void Void Breach />.', 'en'],
      [['title T (', '<arc Jolt />', ')'].join(String.fromCharCode(10)), 'en'],
      ['<stasis Langsam />', 'de'],
      ['Gain <solar/>Scorch and <solar /> stacks.', 'en'],
    ] as const)
      expect(validateText(text, lang, globals)).toEqual([]);
  });
  it('validateTooltip passes an edited language holding a tag', () => {
    const revision = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a' };
    const next = {
      hash: 10,
      text: { en: { ...revision, text: 'Gain <solar Scorch />.' } },
      associated: [],
    } as never;
    expect(validateTooltip(next, () => globals, null)).toEqual([]);
  });
});

describe('preview markers in authored text', () => {
  it('blocks U+E000 and U+E001, which the preview reserves', () => {
    expect(validateText('Gain \uE000Scorch.', 'en', globals)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: reservedMarkerMessage }),
    );
  });
});
