import { expect, it } from 'vitest';
import { parseMarkup } from '@clarity/core';
import { analyzeSourceOnly } from './sourceOnlyChanges';
const globals = { variables: '', titles: '' };
const options = { budgetMs: 10000 };
it.each([
  ['enhanced (\nHidden old\n)', 'enhanced (\nHidden new\n)', 'enhanced'],
  ['var unused = 1', 'var unused = 2', 'variable'],
  ['// old comment', '// new comment', 'comment'],
])('marks a hidden %s edit beside a visible word edit', (old, next, kind) => {
  const before = `Old visible\n${old}`,
    after = `New visible\n${next}`;
  const result = analyzeSourceOnly(before, after, globals, options);
  expect(result.markers.some((marker) => marker.label.includes(kind))).toBe(true);
  expect(result.unchecked).toBe(0);
});
it('marks the intact hidden enhanced block on the never-pushed Adaptive Munitions side', () => {
  const after =
    'Hits against Barrier Champions.\n\nenhanced (\n#e The damage buff is increased by ~40%\n)';
  const result = analyzeSourceOnly('', after, globals, options);
  expect(
    result.markers.some(
      (marker) => marker.label.includes('enhanced') && marker.label.includes('not present'),
    ),
  ).toBe(true);
  expect(result.markers.some((marker) => marker.position > 0)).toBe(true);
});
it('handles pure comments, one-sided inserts/deletes, and active enhanced variants', () => {
  expect(
    analyzeSourceOnly('//old', '//new', globals, options).markers.some((marker) =>
      marker.label.includes('comment'),
    ),
  ).toBe(true);
  expect(analyzeSourceOnly('', '//new', globals, options).markers.length).toBeGreaterThan(0);
  expect(analyzeSourceOnly('//old', '', globals, options).markers.length).toBeGreaterThan(0);
  const before = 'Same\nenhanced (\nOld\n)',
    after = 'Same\nenhanced (\nNew\n)';
  expect(
    analyzeSourceOnly(
      before,
      after,
      { ...globals, type: 'Weapon Trait Enhanced' },
      options,
    ).markers.some((marker) => marker.label.includes('enhanced')),
  ).toBe(false);
});
it('keeps classified markers and reports exactly the unchecked parts at either cap', () => {
  const before = Array.from({ length: 45 }, (_, i) => `// old ${i}\nSame ${i}`).join('\n');
  const after = before.replaceAll('old', 'new');
  const all = analyzeSourceOnly(before, after, globals, { ...options, maxParts: 1000 });
  const bounded = analyzeSourceOnly(before, after, globals, { ...options, maxParts: 40 });
  expect(bounded.markers).toHaveLength(40);
  expect(bounded.unchecked).toBe(all.markers.length - 40);
  let time = 0;
  const timed = analyzeSourceOnly(before, after, globals, {
    now: () => (time += 30),
    budgetMs: 50,
  });
  expect(timed.markers.length).toBeLessThan(all.markers.length);
  expect(timed.unchecked).toBeGreaterThan(0);
});
it('leaves the production render data byte-identical', () => {
  const text = 'Visible\nvar n = 2\nenhanced (\nHidden\n)';
  const saved = JSON.stringify(parseMarkup(text, globals));
  analyzeSourceOnly('Old', text, globals, options);
  expect(JSON.stringify(parseMarkup(text, globals))).toBe(saved);
});
it('retains source identity for malformed Unicode, and distinguishes a variable that renders', () => {
  expect(
    analyzeSourceOnly('// old \ud800', '// new \ud801', globals, options).markers.some((marker) =>
      marker.label.includes('comment'),
    ),
  ).toBe(true);
  expect(
    analyzeSourceOnly(
      'var n = 1\n#n damage',
      'var n = 2\n#n damage',
      globals,
      options,
    ).markers.some((marker) => marker.label.includes('variable')),
  ).toBe(false);
});
it.each([
  ['{{Old}{Hidden old}}', '{{New}{Hidden new}}', globals],
  [
    'enhanced (\nOld\n// hidden old\n)',
    'enhanced (\nNew\n// hidden new\n)',
    { ...globals, type: 'Weapon Trait Enhanced' },
  ],
  ['', 'Visible\ntitle Unused (\nHidden\n)', globals],
  ['', 'Visible\nexport hidden Detail (\nHidden\n)', globals],
  ['Visible\ntitle Unused (\nHidden\n)', '', globals],
  ['Visible\nexport hidden Detail (\nHidden\n)', '', globals],
])('keeps mixed compound source edits explicitly unchecked: %s', (before, after, context) => {
  const result = analyzeSourceOnly(before, after, context, options);
  expect(result.unchecked).toBeGreaterThan(0);
});
