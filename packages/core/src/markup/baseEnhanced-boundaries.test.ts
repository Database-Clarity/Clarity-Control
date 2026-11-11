import { describe, expect, it } from 'vitest';
import { parseMarkup, validateText } from '../index.js';
import { prepareMarkup } from './prepare.js';

const globals = (enhanced = false, imports: Record<string, string> = {}) => ({
  variables: 'var C = 5\nvar Clarity = 7\nvar e = 🡅',
  titles: '',
  type: enhanced ? 'Weapon Trait Enhanced' : 'Weapon Perk',
  imports,
});
const render = (text: string, enhanced = false, imports: Record<string, string> = {}) =>
  prepareMarkup(text, globals(enhanced, imports), []).text;

describe('independent native-token full-pass probes', () => {
  it('keeps unselected-arm variable references from rewriting surrounding text', () => {
    expect(validateText('{{#C}{b}} #Clarity', 'en', globals(true))).toEqual([]);
    expect(render('{{#C}{b}} #Clarity', true)).toBe('b 7');
  });
  it('keeps imported unselected-arm variable references from rewriting importer text', () => {
    expect(render('import main from 124\n#Clarity', true, { 124: '{{#C}{b}}' })).toBe('b\n7');
  });
  it('keeps imported unselected-arm variable references from rewriting title text', () => {
    const text = 'title T (\nimport main from 124\n#Clarity\n)\n<title See [T] />';
    const result = parseMarkup(text, globals(true, { 124: '{{#C}{b}}' }));
    expect(
      result.lines[0].linesContent?.[0].title
        ?.map((l) => l.linesContent?.map((s) => s.text).join(''))
        .join('\n'),
    ).toBe('b\n7');
  });
  it('preserves literal variable boundaries inside a title as in the main body', () => {
    expect(render('#{{C}{e}}')).toBe('#C');
    const result = parseMarkup('title T (\n#{{C}{e}}\n)\n<title See [T] />', globals());
    expect(result.lines[0].linesContent?.[0].title?.[0].linesContent?.[0].text).toBe('#C');
  });
  it('keeps authored math boundaries inside a local title as in the main body', () => {
    const source = '${1+{{2}{3}}}';
    expect(render(source)).toBe('${1+2}');
    const result = parseMarkup(`title T (\n${source}\n)\n<title See [T] />`, globals());
    expect(result.lines[0].linesContent?.[0].title?.[0].linesContent?.[0].text).toBe('${1+2}');
  });
  it('retains suffix and dollar boundaries in both variants', () => {
    for (const enhanced of [false, true]) {
      expect(render('{{#C}{20}}suffix', enhanced)).toBe(enhanced ? '20suffix' : '5suffix');
      expect(render('$' + '{{5}{10}}', enhanced)).toBe(enhanced ? '$10' : '$5');
    }
  });
  it.each([false, true])(
    'passes the earlier C-name, arrow, import, and title counterexamples, variant %s',
    (enhanced) => {
      const imports = { 124: '{{a}{b}}', 125: 'import main from 124' };
      expect(render('var C = 5\n#C\nimport main from 124', enhanced, imports)).toBe(
        `5\n${enhanced ? 'b' : 'a'}`,
      );
      expect(render('#e Other text\nimport main from 125', enhanced, imports)).toBe(
        `🡅 Other text\n${enhanced ? 'b' : 'a'}`,
      );
      const result = parseMarkup(
        'title T (\n#e Other text\nimport main from 124\n)\n<title See [T] />',
        globals(enhanced, imports),
      );
      expect(JSON.stringify(result.lines)).toContain('🡅');
      expect(result.diagnostics).toEqual([]);
      expect(validateText('import main from 124', 'en', globals(enhanced, imports))).toEqual([]);
    },
  );
});

it('keeps active arm references isolated and preserves legacy surrounding comment effects', () => {
  expect(render('{{#C}{b}} #Clarity')).toBe('5 7');
  expect(render('/* #C */\n{{a}{b}} #Clarity', true)).toBe('b 5larity');
  expect(render('/* {{#C}{b}} */\n#Clarity', true)).toBe('5larity');
});
it('retains unknown-variable diagnostics in native local titles and prepares global overrides', () => {
  const text = 'title T (\n{{#Missing}{b}}\n)\n<title See [T] />';
  expect(parseMarkup(text, globals()).diagnostics).toContainEqual({
    severity: 'warning',
    message: 'Unknown variable #Missing.',
  });
  const g = { ...globals(), titles: 'title T (\n#Clarity\n)' };
  expect(JSON.stringify(parseMarkup(text, g).lines)).toContain('7');
});

it('keeps native variable values structural and preserves title whitespace normalization', () => {
  for (const enhanced of [false, true]) {
    const text = 'var X = {{1}{2}}\ntitle T (\n\n#X\n\n)\n<title See [T] />';
    const result = parseMarkup(text, globals(enhanced));
    const title = result.lines[0].linesContent?.[0].title;
    expect(title).toHaveLength(1);
    expect(title?.[0].linesContent?.[0].text).toBe(enhanced ? '2' : '1');
    expect(result.diagnostics).toEqual([]);
  }
});

it('retains legacy title passes around protected inline nodes', () => {
  const g = { ...globals(), variables: 'var A = #B\nvar B = #C\nvar C = 5' };
  expect(prepareMarkup('#A {{x}{y}}', g, []).text).toBe('#B x');
  const result = parseMarkup('title T (\n#A {{x}{y}}\n)\n<title See [T] />', g);
  expect(result.lines[0].linesContent?.[0].title?.[0].linesContent?.[0].text).toBe('#C x');
});
it('never treats the selected arm as a new declaration during structural cleanup', () => {
  const text = '{{var C = 20}{title New (}}';
  expect(render(text)).toBe('var C = 20');
  expect(render(text, true)).toBe('title New (');
  const title = parseMarkup(`title T (\n${text}\n)\n<title See [T] />`, globals());
  expect(title.lines[0].linesContent?.[0].title?.[0].linesContent?.[0].text).toBe('var C = 20');
});
it('keeps pair-free comment and variable semantics when a global native definition is unused', () => {
  const text = '/* #C */\n#Clarity';
  const g = globals();
  const nativeGlobal = { ...g, variables: g.variables + '\nvar Unused = {{a}{b}}' };
  expect(parseMarkup(text, nativeGlobal)).toEqual(parseMarkup(text, g));
});
