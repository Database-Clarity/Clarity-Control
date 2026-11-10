import { prepareMarkup, markupCommentContext } from '../markup/prepare.js';
import { parseMarkup } from '../markup/parse.js';
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
    '0': ['<blue … />', '<green … />', '<purple … />', '<green/>', '<breakSpaces/>'],
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

  it('finds exactly the concept inventory over the eight files and nothing else', () => {
    const all = Object.values(retiredCensus).flatMap(tokens);
    const count = (token: string) => all.filter((found) => found === token).length;
    expect(count('<blue … />')).toBe(6);
    expect(count('<green … />')).toBe(3);
    expect(count('<purple … />')).toBe(2);
    expect(count('<green/>') + count('<purple/>') + count('<breakSpaces/>')).toBe(3);
    expect(all).toHaveLength(14);
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

  it('counts cell styles independently of the retired table', () => {
    expect(findRetiredMarkup('< table wide >\n|bc Name|hr Value\n<$>').map((x) => x.name).sort())
      .toEqual(['background', 'center', 'table']);
  });
});

const names = ['blue', 'green', 'purple', 'center', 'background', 'breakSpaces'];
function oracle(source: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'classNames') {
        for (const name of (item ?? []) as string[]) if ([...names, 'table'].includes(name)) found.push(name);
      } else visit(item);
    }
  };
  visit(parseMarkup(source).lines);
  prepareMarkup(source, { variables: '', titles: '' }, [], (name) => {
    if (name !== 'enhanced') found.push(name);
  });
  return found.sort();
}

describe('parser-truth detection and verified edits', () => {
  it.each(names)('handles every round-one counterexample for %s', (name) => {
    for (const source of [
      `<${name}-x />`, `<${name}>x`, `<${name} / >`,
      `<${name.slice(0, 2)}/* note */${name.slice(2)} x />`,
      `<<yellow/>${name} x />`, `<<bold/>${name} x />`,
      `<yellow a <${name}/> b />`,
      `< table wide >\n|<yellow a <${name}/> b />\n<$>`,
      `// <${name}/>`, `/* <${name}/> */`,
      `title info (\n<${name} x />\n)\n<title See [info] />`,
      `catalyst (\n<${name} x />\n)`,
    ]) expect(findRetiredMarkup(source).map((x) => x.name).sort(), source).toEqual(oracle(source));
  });

  it('bounds unmapped findings to the containing source line or table', () => {
    for (const name of names) {
      const source = `Before\n<${name}>x\nAfter`;
      const finding = findRetiredMarkup(source)[0]!;
      expect(finding).toMatchObject({ from: 7, to: 7 + `<${name}>x`.length, source: `<${name}>x` });
    }
    const table = '< table >\n|c Value\n<$>';
    const source = `Before\n${table}\nAfter`;
    expect(findRetiredMarkup(source).find((item) => item.name === 'center'))
      .toMatchObject({ from: 7, to: 7 + table.length, source: table });
  });

  it('has bidirectional parity over 512 generated mixes', () => {
    let seed = 0x1e71eed;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const pieces = [
      ...names.flatMap((name) => [`<${name}/>`, `<${name} x />`, `<${name}-x />`, `<${name}>x`,
        `<${name} / >`, `<<yellow/>${name} x />`, `<yellow a <${name}/> b />`]),
      '/* keep |blue */', '// <green/>', '<bold/>', '<yellow a />', 'plain',
      '< table wide >\n|bc x|hr <purple p />\n<$>',
      'catalyst (\nx\n)', 'exotic perk (\n<green x />\n)',
      'enhanced (\ncatalyst (\nx\n)\n)',
      'title info (\n<blue x />\n)\n<title See [info] />',
    ];
    for (let index = 0; index < 512; index++) {
      const source = Array.from({ length: 1 + random(8) }, () => pieces[random(pieces.length)]).join(random(2) ? '\n' : ' ');
      expect(findRetiredMarkup(source).map((x) => x.name).sort(), source).toEqual(oracle(source));
    }
  });

  it('makes minimal wrapper edits, keeping supported markers at every position', () => {
    for (const supported of ['yellow', 'bold']) {
      for (const source of [`<<${supported}/>blue x />`, `<blue <${supported}/>x />`, `<blue x<${supported}/> />`]) {
        const occurrence = findRetiredMarkup(source).find((x) => x.name === 'blue')!;
        expect(occurrence.fixes.length, source).toBeGreaterThan(0);
        const after = applyRetiredEdits(source, occurrence.fixes[0]!.edits);
        expect(after).toContain(`<${supported}/>`);
        expect(JSON.stringify(parseMarkup(after).lines)).toContain(supported);
        expect(occurrence.fixes[0]!.edits.every((edit) => edit.insert === '')).toBe(true);
      }
    }
  });

  it('keeps comments byte for byte, including split names and delimiter padding', () => {
    for (const source of ['<blue a /* keep */ b />',
      '<bl/* note */ue x />', '<blue/>/* keep */x', 'x/* keep */<blue/>']) {
      const first = findRetiredMarkup(source)[0]!;
      expect(first.fixes.length, source).toBeGreaterThan(0);
      const after = applyRetiredEdits(source, first.fixes[0]!.edits);
      const comments = (text: string) => markupCommentContext(text).comments.map(({from, to}) => text.slice(from, to));
      expect(comments(after)).toEqual(comments(source));
    }
  });

  it('refuses structural fixes for all comment positions, including both P1 and P2 probes', () => {
    for (const source of [
      '< table /* keep\n note */wide >\n|x\n<$>',
      '< table wide >\n|x /* keep |blue */|value\n<$>',
      '< table wide >\n|x\n<$> // keep',
      'catalyst (\n// keep\nx\n)', 'exotic perk (\nx /* keep */\n)',
    ]) {
      const occurrences = findRetiredMarkup(source);
      expect(occurrences.length, source).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        expect(occurrence.fixes, source).toEqual([]);
        expect(occurrence.refusalReason).toBeTruthy();
      }
      expect(fixAllRetired(source).text).toBe(source);
    }
  });

  it('refuses malformed spans and any conversion losing supported styles or visible text', () => {
    for (const source of ['<blue-x />', '<blue>x', '<blue / >', '<blue /* keep */ />',
      '< table wide >\n|b Name|value\n<$>', '< table >\n|b Name\n<$>']) {
      const found = findRetiredMarkup(source);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((x) => x.fixes.length === 0), source).toBe(true);
      expect(found.every((x) => x.message.includes('Fix by hand'))).toBe(true);
    }
  });

  it('uses production condition recognition before comment removal', () => {
    expect(findRetiredMarkup('catalyst (\nx\n) // end')).toEqual([]);
    expect(findRetiredMarkup('catalyst (\nx\n)   ')).toEqual([]);
    for (const name of ['catalyst', 'exotic perk']) {
      const source = `Before\n${name} (\ntext\n)\nAfter`;
      expect(findRetiredMarkup(source)[0]!.fixes).toEqual([]);
      expect(findRetiredMarkup(source)[0]!.refusalReason).toContain('parser');
    }
  });

  it('offers only fixes verified to remove retired classes without introducing yellow', () => {
    const source = 'a <blue Solar Fulmination /> b <green x /> c';
    expect(fix(source, 0, 'remove-tag')).toBe('a Solar Fulmination b <green x /> c');
    expect(findRetiredMarkup(source)[0]!.fixes.map((x) => x.id)).toEqual(['remove-tag']);
    expect(fix('<purple/> While this heals', 0, 'remove-marker')).toBe('While this heals');
    expect(fix('Heals fully <purple/>', 0, 'remove-marker')).toBe('Heals fully');
  });

  it('Fix all skips refused/structural forms and is idempotent across the real census', () => {
    for (const source of [...Object.values(retiredCensus), '<blue-x /> <green good />',
      'catalyst (\nx\n)\n<blue y />']) {
      const first = fixAllRetired(source);
      expect(fixAllRetired(first.text)).toEqual({ text: first.text, fixed: 0, remaining: first.remaining });
      expect(first.remaining).toBe(findRetiredMarkup(first.text).length);
    }
    const result = fixAllRetired('<blue-x />\n<green good />');
    expect(result).toEqual({ text: '<blue-x />\ngood', fixed: 1, remaining: 1 });
  });

  it('records verification cost on the largest real tooltip', () => {
    const source = Object.values(retiredCensus).sort((a, b) => b.length - a.length)[0]!;
    const start = performance.now();
    for (let index = 0; index < 20; index++) findRetiredMarkup(source);
    console.info(`retired verification: largest census tooltip ${source.length} chars; ${((performance.now() - start) / 20).toFixed(3)} ms/scan (20 scans)`);
  });
});
