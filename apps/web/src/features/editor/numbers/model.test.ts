import { expect, it } from 'vitest';
import { numberSource } from './model';

it('adds line numbers to otherwise identical contexts', () => {
  const source = numberSource('Lasts 5 seconds.\nLasts 5 seconds.', undefined, 'de');
  expect(source.slots.map((slot) => slot.breadcrumb)).toEqual([
    'Main text · line 1',
    'Main text · line 2',
  ]);
});

it('keeps equal values distinct under different headings and formats live values', () => {
  const source = numberSource(
    'PvE:\nLasts 4.5 seconds.\nPvP:\nLasts 4.5 seconds.',
    undefined,
    'de',
  );
  expect(source.slots.map((slot) => slot.display)).toEqual(['4,5', '4,5']);
  expect(source.slots[0].context).toBe(source.slots[1].context);
  expect(source.slots[0].breadcrumb).not.toBe(source.slots[1].breadcrumb);
  expect(source.byDisplay.get('4,5')).toEqual([1, 2]);
});

it('takes formula display values through the real conditional markup resolver', () => {
  const text = 'Damage ${5+#d}.\nvar d = 0\nenhanced (\nvar d = 2\n)';
  const base = numberSource(text, undefined, 'de');
  const enhanced = numberSource(text, undefined, 'de', {
    variables: '',
    titles: '',
    type: 'Weapon Trait Enhanced',
  });
  expect(base.slots[0].display).toBe('5');
  expect(enhanced.slots[0].display).toBe('7');
});

it('never guesses ids while an unsaved English structure has an old map', () => {
  const source = numberSource('Value 5 and new 10.', { ids: [7], next: 8, retired: {} }, 'de');
  expect(source.slots).toEqual([]);
  expect(source.values.size).toBe(0);
  expect(source.issue).toContain('Save English');
});
