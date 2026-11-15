import { expect, it } from 'vitest';
import { numberSource } from './model';

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
