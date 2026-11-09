import { describe, expect, it } from 'vitest';
import { validateText } from './index.js';
import {
  applyRetiredEdits,
  findRetiredMarkup,
  fixAllRetired,
  type RetiredFixId,
} from './retired.js';
import { retiredCensus } from './retired.census.js';

const tokens = (text: string) => findRetiredMarkup(text).map((found) => found.token);
const fix = (text: string, index: number, id: RetiredFixId) => {
  const found = findRetiredMarkup(text)[index]!;
  return applyRetiredEdits(text, found.fixes.find((candidate) => candidate.id === id)!.edits);
};

describe('retired markup census', () => {
  const counts: Record<string, string[]> = {
    '569260333': ['<blue … />'],
    '1694242448': ['<purple … />'],
    '1890422124': ['<green … />'],
    '2130042297': ['<green … />'],
    '2799418574': ['<blue … />', '<blue … />'],
    '3640170453': ['<purple/>'],
    '4185339856': ['<blue … />', '<blue … />'],
  };

  it.each(Object.entries(counts))('flags every retired form in tooltip %s', (hash, expected) => {
    expect(tokens(retiredCensus[hash]!)).toEqual(expected);
  });

  it('words the warning as the concept does and underlines the whole token', () => {
    const text = retiredCensus['2799418574']!;
    const [first, second] = validateText(text, 'en').filter((issue) => issue.code === 'retired');
    expect(first).toMatchObject({
      severity: 'warning',
      message:
        'Retired markup <blue … />: no longer supported. Remove the tag (the text stays) or change it to <yellow … />.',
    });
    expect(text.slice(first!.from, first!.to)).toBe('<blue Solar Fulmination />');
    expect(text.slice(second!.from, second!.to)).toBe("<blue Hunter's Journal Artifact />");
  });

  it('never flags yellow, bold, pve, pvp, title, link, icons, or comments', () => {
    const clean = [
      '<yellow Hawkmoon /> <bold Special Note: /> <pve 35% /> <pvp [10%] />',
      '<title 25% of the benefits [fusions] /> <link Text [#Name] /> <arc/>Bolt Charge <solar/>',
      '<bold/>whole line bold\n<yellow/>line tag',
      '// <blue old note />\n/* <purple/> */ plain',
      'The blue flower, green grass, a purple <b> sky, background music, and a center.',
    ];
    for (const text of clean) expect(findRetiredMarkup(text), text).toEqual([]);
    // The census texts hold yellow and bold too, and only the retired tags are flagged.
    expect(tokens(retiredCensus['1694242448']!)).toHaveLength(1);
    expect(tokens(retiredCensus['4185339856']!)).toHaveLength(2);
  });

  it('flags every other retired form, with whitespace variants', () => {
    expect(tokens('<center/>a\n<breakSpaces/>b\n<background/>c\n<blue />d\n<center />e')).toEqual([
      '<center/>',
      '<breakSpaces/>',
      '<background/>',
      '<blue/>',
      '<center/>',
    ]);
    expect(tokens('<blue  two spaces /> <green\tx /> <background text /> <center text />')).toEqual(
      ['<blue … />', '<green … />', '<background … />', '<center … />'],
    );
    expect(tokens('catalyst (\nOnly with the catalyst\n)\nexotic perk (\nperk\n)')).toEqual([
      'catalyst ( … )',
      'exotic perk ( … )',
    ]);
    expect(tokens('< table background_1 >\n|b Name|c Value\n|Row|1\n<$>')).toEqual(['< table … >']);
  });
});

describe('retired markup fixes', () => {
  it('removes a wrapper and keeps its text, or changes it to yellow', () => {
    const text = 'a <blue Solar Fulmination /> b <green [Controller-Only] /> c';
    expect(fix(text, 0, 'remove-tag')).toBe('a Solar Fulmination b <green [Controller-Only] /> c');
    expect(fix(text, 0, 'to-yellow')).toBe(
      'a <yellow Solar Fulmination /> b <green [Controller-Only] /> c',
    );
    expect(fix(text, 1, 'remove-tag')).toBe('a <blue Solar Fulmination /> b [Controller-Only] c');
    expect(findRetiredMarkup(text)[0]!.fixes.map((candidate) => candidate.id)).toEqual([
      'remove-tag',
      'to-yellow',
    ]);
  });

  it('offers only Remove tag for background and centre wrappers', () => {
    const found = findRetiredMarkup('<background x /> <center y />');
    expect(found.map((one) => one.fixes.map((candidate) => candidate.id))).toEqual([
      ['remove-tag'],
      ['remove-tag'],
    ]);
  });

  it('removes a marker with one neighbouring space and nothing else', () => {
    expect(fix('<purple/> While this heals', 0, 'remove-marker')).toBe('While this heals');
    expect(fix('Heals fully <purple/>', 0, 'remove-marker')).toBe('Heals fully');
    expect(fix('a <center/> b', 0, 'remove-marker')).toBe('a  b');
    expect(fix('<breakSpaces/>x  ', 0, 'remove-marker')).toBe('x  ');
  });

  it('marks block and table fixes as structural and rewrites them exactly', () => {
    const block = 'before\ncatalyst (\nline one\nline two\n)\nafter';
    const [found] = findRetiredMarkup(block);
    expect(found!.fixes.every((candidate) => candidate.structural)).toBe(true);
    expect(fix(block, 0, 'remove-block')).toBe('before\nafter');
    expect(fix(block, 0, 'keep-contents')).toBe('before\nline one\nline two\nafter');
    expect(fix('x\ncatalyst (\ny\n)', 0, 'remove-block')).toBe('x');
    const table = 'Intro\n< table wide >\n|b Name|c Value\n|Reload| 100\n<$>\nOutro';
    expect(fix(table, 0, 'rows-to-lines')).toBe('Intro\nName | Value\nReload | 100\nOutro');
  });

  it('Fix all clears every simple form, leaves structural ones, and is idempotent', () => {
    for (const text of Object.values(retiredCensus)) {
      const first = fixAllRetired(text);
      expect(findRetiredMarkup(first.text)).toEqual([]);
      expect(first.remaining).toBe(0);
      expect(fixAllRetired(first.text)).toEqual({ text: first.text, fixed: 0, remaining: 0 });
    }
    expect(fixAllRetired(retiredCensus['2799418574']!).text).toContain(
      "Solar Fulmination from the Hunter's Journal Artifact doubles",
    );
    expect(fixAllRetired('<purple/> <blue/> a <green x />').text).toBe('a x');
    const mixed = 'catalyst (\nx\n)\n<blue y />';
    expect(fixAllRetired(mixed)).toEqual({ text: 'catalyst (\nx\n)\ny', fixed: 1, remaining: 1 });
  });
});
