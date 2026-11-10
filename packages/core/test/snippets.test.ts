import { describe, expect, test } from 'vitest';
import {
  applicableTransforms,
  expandSnippet,
  expandTemplate,
  markupSnippets,
  markupSymbols,
  markupTags,
  markupTransforms,
  parseMarkup,
  validateText,
} from '../src/index.js';

const globals = { variables: 'var e = 🡅', titles: 'title G_refill (\nRefills.\n)' };

describe('snippet templates', () => {
  test('stops are offsets into the expanded text, {{0}} comes last', () => {
    const expanded = expandTemplate('{{2:b}} and {{1:a}}{{0}}');
    expect(expanded.text).toBe('b and a');
    expect(expanded.stops.map((stop) => expanded.text.slice(stop.from, stop.to))).toEqual([
      'a',
      'b',
      '',
    ]);
  });
  test('a selection replaces the first stop only', () => {
    const expanded = expandTemplate('<pve {{1:value}} /> <pvp [{{2:value}}] />', '6.5');
    expect(expanded.text).toBe('<pve 6.5 /> <pvp [value] />');
    expect(expanded.text.slice(expanded.stops[1]!.from, expanded.stops[1]!.to)).toBe('value');
  });
  test('the enhanced formula keeps its literal ${ }', () => {
    const expanded = expandTemplate('#e${{{1:base}}+#d}', '12');
    expect(expanded.text).toBe('#e${12+#d}');
  });
  test('wrapping snippets wrap each selected line', () => {
    const wrap = markupSnippets.find((snippet) => snippet.id === 'wrap:yellow')!;
    expect(expandSnippet(wrap, 'one\ntwo').text).toBe('<yellow one />\n<yellow two />');
  });
});

describe('the catalogue', () => {
  test('Prismatic is a symbol, renders as an icon, and supports the word transform', () => {
    expect(markupSymbols.find((symbol) => symbol.name === 'prismatic')?.id).toBe('icon:prismatic');
    const parsed = parseMarkup('<prismatic/>Transcendence');
    expect(parsed.diagnostics).toEqual([]);
    expect(JSON.stringify(parsed.lines)).toContain('prismatic');
    expect(JSON.stringify(parsed.lines)).not.toContain('<prismatic/>');
    expect(
      applicableTransforms('Prismatic').find((entry) => entry.transform.id === 'element-icon')
        ?.output,
    ).toBe('<prismatic/>Prismatic');
  });
  test('has separate PvE and PvP tags next to the pair preset, and no tables', () => {
    const ids = markupSnippets.map((snippet) => snippet.id);
    expect(ids).toEqual(expect.arrayContaining(['pve', 'pvp', 'pair', 'pvp-override']));
    for (const text of [
      ...markupSnippets.flatMap((snippet) => [snippet.id, snippet.label, snippet.template]),
      ...markupTags.flatMap((tag) => [tag.id, tag.label, tag.template]),
      ...markupSymbols.map((symbol) => symbol.name),
    ]) {
      expect(text).not.toMatch(/table|<\$>|\|[bchr]\d? /i);
    }
  });

  test('every snippet expands to markup the parser reads without errors', () => {
    for (const snippet of markupSnippets) {
      // An import has no source to resolve until the author names one.
      if (snippet.id === 'decl-import') continue;
      const { text } = expandSnippet(snippet);
      const diagnostics = parseMarkup(text, globals).diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
      expect(diagnostics, snippet.id).toEqual([]);
      expect(text, snippet.id).not.toContain('{{');
    }
  });

  test('every snippet matches its own usage pattern, so the corpus count is meaningful', () => {
    for (const snippet of markupSnippets) {
      // Blocks begin lines; a fragment is judged inside a sentence.
      const text = expandSnippet(snippet).text;
      expect(snippet.usage.test(snippet.block ? text : `Gains ${text} more`), snippet.id).toBe(
        true,
      );
    }
  });

  test('the enhanced section carries the enhanced arrow and validates in an enhanced tooltip', () => {
    const block = expandSnippet(markupSnippets.find((snippet) => snippet.id === 'enhanced-block')!);
    expect(block.text).toContain('\n#e ');
    const text = `Base text.\n\n${block.text.replace('amount', '1')}`;
    const enhanced = parseMarkup(text, { ...globals, type: 'Weapon Trait Enhanced' });
    expect(
      enhanced.lines.flatMap((line) => line.linesContent ?? []).map((part) => part.text),
    ).toContain('🡅');
    const base = parseMarkup(text, { ...globals, type: 'Weapon Trait' });
    expect(JSON.stringify(base.lines)).not.toContain('🡅');
    expect(validateText(text, 'en', { ...globals }, false)).not.toContainEqual(
      expect.objectContaining({ severity: 'error' }),
    );
  });
});

describe('transforms', () => {
  const run = (input: string, titles: string[] = []) =>
    Object.fromEntries(
      applicableTransforms(input, { titles }).map(({ transform, output }) => [
        transform.id,
        output,
      ]),
    );

  test('X [Y] becomes the PvE/PvP pair and keeps trailing words outside', () => {
    expect(run('6.5 [5]')).toEqual({ pair: '<pve 6.5 /> <pvp [5] />' });
    expect(run('40% [35%] damage').pair).toBe('<pve 40% /> <pvp [35%] /> damage');
  });
  test('a number becomes a PvE value and [n] a PvP value', () => {
    expect(run('12')).toEqual({ 'number-pve': '<pve 12 />' });
    expect(run('[12%]')).toEqual({ 'bracket-pvp': '<pvp [12%] />' });
  });
  test('an element word gets its icon, keeping the author casing', () => {
    expect(run('Solar')).toEqual({ 'element-icon': '<solar/>Solar' });
    expect(run('stasis')).toEqual({ 'element-icon': '<stasis/>stasis' });
  });
  test('comma lists of values become pipe lists', () => {
    expect(run('1, 2.5, 4')).toEqual({ 'pipe-list': '1|2.5|4' });
  });
  test('multi-line selections transform per line and leave other lines alone', () => {
    expect(run('1 [2]\ntext\n3 [4]').pair).toBe(
      '<pve 1 /> <pvp [2] />\ntext\n<pve 3 /> <pvp [4] />',
    );
  });
  test('a term that names one title becomes a reference; two candidates are ambiguous', () => {
    expect(run('refill', ['G_refill'])['title-reference']).toBe('<title refill [G_refill] />');
    expect(run('Refill', ['Refill', 'G_refill'])['title-reference']).toBe(
      '<title Refill [Refill] />',
    );
    expect(run('refill', ['G_refill', 'G_REFILL'])['title-reference']).toBeUndefined();
    expect(run('refill', [])['title-reference']).toBeUndefined();
  });
  test('ambiguous or already-marked-up selections produce nothing', () => {
    expect(run('1 [2] 3 [4]')).toEqual({});
    expect(run('<pve 1 /> [2]')).toEqual({});
    expect(run('#d [2]')).toEqual({});
    expect(run('1, two')).toEqual({});
    expect(run('Kinetic energy')).toEqual({});
    expect(run('')).toEqual({});
    expect(markupTransforms.length).toBeGreaterThan(4);
  });
});
