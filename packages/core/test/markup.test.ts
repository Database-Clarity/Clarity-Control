import {
  descriptionConverter,
  type DescriptionLine,
  type IntermediatePerk,
} from '@icemourne/description-converter';
import { describe, expect, test } from 'vitest';
import { markupCommentContext, parseMarkup } from '../src/markup/index.js';
import { evaluateMarkupMath } from '../src/markup/arithmetic.js';
import { removeMarkupComments } from '../src/markup/prepare.js';
import { database } from './helpers.js';

function withoutStats(lines: DescriptionLine[] | undefined): unknown {
  return (
    lines?.map((line) => ({
      ...line,
      linesContent: line.linesContent
        ?.filter((part) => !part.formula)
        .map((part) => ({
          ...part,
          title: part.title ? withoutStats(part.title) : undefined,
        })),
      table: line.table?.map((row) => ({
        ...row,
        rowContent: row.rowContent?.map((cell) => ({
          ...cell,
          cellContent: cell.cellContent
            .filter((part) => !part.formula)
            .map((part) => ({
              text: part.text,
              classNames: part.classNames,
              title: part.title ? withoutStats(part.title) : undefined,
            })),
        })),
      })),
    })) ?? []
  );
}

test.each([
  '<bold Damage > /*\nignored\n*/10 />',
  'a /* one */ middle /* two */\nb',
  'a / /* hidden */ / hidden\nnext',
  'before // ignored\r\nafter',
  '// first\nvisible\n/* block */\nlast',
  '😀 before /* comment */ after',
])('maps the renderer comment removal back to authored offsets: %s', (doc) => {
  const context = markupCommentContext(doc);
  expect(context.text).toBe(removeMarkupComments(doc));
  expect(context.offsets.map((offset) => doc[offset]).join('')).toBe(context.text);
  for (const comment of context.comments) {
    expect(comment.from).toBeGreaterThanOrEqual(0);
    expect(comment.to).toBeGreaterThan(comment.from);
    expect(comment.to).toBeLessThanOrEqual(doc.length);
  }
});

describe.each(['live', 'intermediate'])('%s real-tooltip converter golden parity', (source) => {
  const raw = database(source);
  // The legacy oracle's narrow type is safe here: these are schema-validated real legacy fixtures.
  const perks = structuredClone(raw.perks) as Record<string, IntermediatePerk>;
  for (const perk of Object.values(perks)) {
    for (const text of Object.values(perk.editor)) {
      if (text) text.secondary = text.main;
    }
  }
  const importCatalogs = new Map<string, Record<string, string>>();
  test('untagged descriptions match the published converter, except removed stat formulas', () => {
    let compared = 0;
    const scoped: string[] = [];
    for (const perk of Object.values(perks)) {
      for (const language of Object.keys(perk.editor)) {
        const lang = language as keyof typeof perk.editor;
        if (!importCatalogs.has(lang)) {
          importCatalogs.set(
            lang,
            Object.fromEntries(
              Object.entries(perks).map(([hash, item]) => [hash, item.editor[lang]?.main ?? '']),
            ),
          );
        }
        const text = perk.editor[lang]?.main ?? '';
        // Scoped descriptions intentionally differ: all bodies now have ordinary headings.
        if (/< weapon type|<weapons/i.test(text)) {
          scoped.push(`${perk.hash}/${lang}`);
          const lines = JSON.stringify(parseMarkup(text).lines);
          for (const label of ['Auto Rifle', 'Glaive', 'Other weapons'])
            expect(lines).toContain(label);
          expect(lines.match(/Apply this text/g)).toHaveLength(3);
          expect(lines).not.toContain('weaponTypes');
          continue;
        }
        const actual = parseMarkup(text, {
          variables: perks[2].editor[lang]?.main ?? '',
          titles: perks[3].editor[lang]?.main ?? '',
          imports: importCatalogs.get(lang),
          type: perk.type,
        });
        const expected = descriptionConverter({
          descriptionString: text,
          editorType: 'main',
          language: lang,
          hash: perk.hash,
          database: perks,
        });
        expect(JSON.parse(JSON.stringify(actual.lines)), `${source}/${perk.hash}/${lang}`).toEqual(
          JSON.parse(JSON.stringify(withoutStats(expected))),
        );
        compared++;
      }
    }
    expect(scoped).toEqual(['0/en']);
    expect(compared).toBe(2760);
  }, 30_000);
});

test('variables, local/global titles, imports, comments, tables, spans and conditional sections', () => {
  const result = parseMarkup(
    [
      'var local = 2',
      'title Local (',
      '<green #local />',
      ')',
      'import Shared from global',
      'import main from 42',
      '<title Details [Local] /> <title Global [Info] />',
      '< table background_1 >',
      '|b2 one |c-2 <solar/> two',
      '<$>',
      'enhanced (',
      '#e Bonus',
      ')',
      '// omitted',
    ].join('\n'),
    {
      variables: 'var e = 🡅',
      titles: 'title Info (\nHello\n)',
      imports: { '1': 'export hidden Shared (\nShared text\n)', '42': '<bold Imported />' },
      type: 'Weapon Trait Enhanced',
    },
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.lines[0].linesContent?.[0].text).toBe('Shared text');
  expect(JSON.stringify(result.lines)).toContain('Imported');
  expect(JSON.stringify(result.lines)).toContain('Hello');
  expect(result.lines.find((line) => line.table)?.table?.[0].rowContent?.[0].colSpan).toBe(2);
  expect(JSON.stringify(result.lines)).not.toContain('omitted');
});

test.each([
  ['${1+2*3}', '7'],
  ['${10-2*3}', '4'],
  ['${10 - -2}', '12'],
  ['${-1.005}', '-1'],
  ['${1.005}', '1.01'],
  ['${3/7}', '0.43'],
  ['${1/0}', 'Infinity'],
  ['${0/0}', 'NaN'],
  ['${alert("no")}', '${alert("no")}'],
  ['${2; alert("no")}', '2'],
])('numeric expression %s is evaluated without code execution', (input, expected) => {
  expect(evaluateMarkupMath(input)).toBe(expected);
});

test('missing imports and variables are explicit and cycles are bounded', () => {
  expect(parseMarkup('import Missing from 44\n#unknown').diagnostics).toEqual([
    { severity: 'error', message: 'Unresolved import "Missing" from 44.' },
    { severity: 'warning', message: 'Unknown variable #unknown.' },
  ]);
  expect(
    parseMarkup('import main from 42', {
      variables: '',
      titles: '',
      imports: { '42': 'import main from 42' },
    }).diagnostics[0].message,
  ).toContain('five passes');
});

test('references inside comments and hidden exports do not create spurious warnings', () => {
  expect(
    parseMarkup('/*\n#unknown\nimport Missing from 44\n*/\nVisible // #other').diagnostics,
  ).toEqual([]);
  expect(
    parseMarkup('export hidden Private (\n#unknown\nimport Missing from 44\n)\nVisible')
      .diagnostics,
  ).toEqual([]);
});
