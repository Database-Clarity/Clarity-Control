import { describe, expect, it } from 'vitest';
import { validateText, validateTextWithReads, validateTooltip } from './index.js';

const globals = {
  variables: 'var damage = 10',
  titles: 'title Known (\nA title\n)',
  imports: { '123': 'Imported text', '456': 'Imported text' },
};

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
      validateTooltip(
        tooltip,
        () => globals,
        tooltip,
        { aliases: {}, affectedBy: () => '"Donor" (124)' },
      ),
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
      validateTooltip(
        tooltip,
        () => globals,
        tooltip,
        { aliases: {}, affectedBy: () => undefined },
      ),
    ).toMatchObject([{ severity: 'warning' }]);
  });
});

describe('recorded validation reads', () => {
  it('records alias keys, missing imports, from global, and global title imports in their language', () => {
    const catalog = { '456': 'Shared', '1': 'Global' };
    const recorded = validateTextWithReads(
      'import main from 456\nimport main from global', 'fr',
      { variables: '', titles: 'title Unused (\nimport x from 999\n)', imports: catalog },
      false, 10, { 456: { to: 123, kind: 'sandbox' } },
    );
    expect(recorded.reads.lang).toBe('fr');
    expect([...recorded.reads.imports]).toEqual(expect.arrayContaining([
      ['456', 123], ['global', 1], ['1', 1], ['999', 999],
    ]));
    expect(recorded.issues).toEqual(validateText(
      'import main from 456\nimport main from global', 'fr',
      { variables: '', titles: 'title Unused (\nimport x from 999\n)', imports: catalog }, false, 10,
    ));
    expect(recorded.reads.sources.has('Shared')).toBe(true);
  });
});
