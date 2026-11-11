import { describe, expect, it } from 'vitest';
import { parseMarkup, scanBaseEnhanced, validateText } from '../index.js';
import { prepareMarkup } from './prepare.js';

const globals = (enhanced = false) => ({
  variables: 'var C = 5\nvar e = 🡅',
  titles: '',
  type: enhanced ? 'Weapon Trait Enhanced' : 'Weapon Perk',
  imports: {
    124: '{{a}{b}}',
    125: 'import main from 124',
    126: 'export Values (\n{{10}{20}}\n)',
  },
});
const prepare = (text: string, enhanced = false) => prepareMarkup(text, globals(enhanced), []).text;
describe('native base/enhanced inline markup', () => {
  it('selects only the correct arm and keeps unrelated variables and arrows intact', () => {
    const text = '#C #e Other {{10%}{20%}} text {{a}{b}}.';
    expect(prepare(text)).toBe('5 🡅 Other 10% text a.');
    expect(prepare(text, true)).toBe('5 🡅 Other 20% text b.');
  });
  it('preserves native token boundaries beside variables, dollar signs, and suffixes', () => {
    expect(prepare('{{#C}{20}}suffix')).toBe('5suffix');
    expect(prepare('#{{C}{e}}')).toBe('#C');
    expect(prepare('$' + '{{5}{10}}')).toBe('$5');
    expect(prepare('{{#C}{20}}suffix', true)).toBe('20suffix');
    expect(prepare('#e Plain text\nimport main from 124')).toBe('🡅 Plain text\na');
  });
  it('supports symbols, tags, numbers, variables, and arithmetic in either arm', () => {
    const text = '{{<kinetic/> <pve #C% /> ${2+3}}{<solar/> <pvp [10%] /> ${3*3}}}';
    for (const enhanced of [false, true]) {
      const result = parseMarkup(text, globals(enhanced));
      expect(result.diagnostics).toEqual([]);
      expect(JSON.stringify(result.lines)).toContain(enhanced ? 'solar' : 'kinetic');
      expect(prepare(text, enhanced)).toContain(enhanced ? '9' : '5');
      expect(prepare(text, enhanced)).not.toContain('{{');
    }
  });
  it.each([
    '{{a}{',
    '{{a}',
    '{{a}{b}',
    '{{}{b}}',
    '{{a}{}}',
    '{{a}{b\nc}}',
    '{{a {{b}{c}}}{d}}',
    '{{a}{b {{c}{d}}}}',
  ])('blocks malformed or nested %s', (text) => {
    expect(scanBaseEnhanced(text).issues.length).toBeGreaterThan(0);
    expect(validateText(text, 'en').some((issue) => issue.severity === 'error')).toBe(true);
  });
  it('points unfinished-pair diagnostics at the opener, preserving comment offsets', () => {
    const text = '/* {{ignored */\nPrecision {{70}{';
    const issue = validateText(text, 'en').find((issue) => issue.severity === 'error')!;
    expect(issue.from).toBe(text.lastIndexOf('{{'));
    expect(issue.to).toBe(text.length);
  });
  it('uses the importing variant for direct, nested, named, and title imports', () => {
    for (const enhanced of [false, true]) {
      expect(prepare('#C\nimport main from 124', enhanced)).toBe(`5\n${enhanced ? 'b' : 'a'}`);
      expect(prepare('import main from 125', enhanced)).toBe(enhanced ? 'b' : 'a');
      expect(prepare('import Values from 126', enhanced)).toBe(enhanced ? '20' : '10');
      const result = parseMarkup(
        'title Ref (\nimport main from 124\n)\n<title See [Ref] />',
        globals(enhanced),
      );
      expect(JSON.stringify(result.lines)).toContain(`"text":"${enhanced ? 'b' : 'a'}"`);
    }
  });
  it('resolves native pairs in global definitions with the same variant', () => {
    for (const enhanced of [false, true]) {
      const g = {
        ...globals(enhanced),
        variables: 'var X = {{3}{4}}',
        titles: 'title T (\n{{x}{y}}\n)',
      };
      const result = parseMarkup('#X <title See [T] />', g);
      expect(JSON.stringify(result.lines)).toContain(enhanced ? '4 ' : '3 ');
      expect(JSON.stringify(result.lines)).toContain(`"text":"${enhanced ? 'y' : 'x'}"`);
    }
  });
  it('keeps comments opaque and diagnostics on unresolved/cyclic imports', () => {
    expect(parseMarkup('text // {{unfinished', globals()).diagnostics).toEqual([]);
    expect(parseMarkup('import main from 999', globals()).diagnostics[0]?.severity).toBe('error');
    const g = { ...globals(), imports: { 124: 'import main from 124' } };
    expect(parseMarkup('import main from 124', g).diagnostics[0]?.message).toContain('five passes');
  });
});
