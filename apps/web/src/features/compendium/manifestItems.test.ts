import { expect, it } from 'vitest';
import { groupManifestItems } from './manifestItems';

it('groups manifest facts through alias chains while keeping distinct names and descriptions', () => {
  const item = (hash: number, name: string, inGameDescription: string) => ({
    hash,
    name,
    inGameDescription,
    categoryId: 'frame',
    icon: '',
  });
  const groups = groupManifestItems(
    {
      100: item(100, 'Base', 'Base text'),
      101: item(101, 'Alias', 'Other text'),
      102: item(102, 'Third', ''),
      200: item(200, 'Separate', 'Text'),
    },
    { 101: { to: 100, kind: 'frame' }, 102: { to: 101, kind: 'sandbox' } },
  );
  expect(groups.get(100)?.map(({ name, inGameDescription }) => [name, inGameDescription])).toEqual([
    ['Base', 'Base text'],
    ['Alias', 'Other text'],
    ['Third', ''],
  ]);
  expect(groups.get(200)?.[0].name).toBe('Separate');
  expect(groups.has(101)).toBe(false);
});
