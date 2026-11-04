import { expect, it } from 'vitest';
import type { CompendiumSheet } from '@clarity/core';
import { pickerRows } from './pickerRows';
const row = (name: string, rowIndex: number, section = 'Traits') => ({
  name,
  nameNorm: name.toLowerCase(),
  rowIndex,
  section,
  cell: { plain: 'Description', runs: [{ text: 'Description' }] },
});
const tab: CompendiumSheet = {
  gid: 'test',
  name: 'Test',
  rows: [
    row('Beta', 4, 'Alpha reference'),
    row('Alphabet', 3),
    row('Alpha', 10),
    row('A Alpha', 5),
    row('Alpha', 2),
  ],
};
it('shows all rows alphabetically and breaks duplicate-name ties by physical row', () => {
  const result = pickerRows(tab, 'weapon-trait', '', '');
  expect(result.rows.map((r) => r.rowIndex)).toEqual([5, 2, 10, 3, 4]);
  expect(result.exact.size).toBe(0);
});
it('promotes exact identifiers while retaining partial name and section search results', () => {
  const result = pickerRows(tab, 'weapon-trait', 'Alpha', '');
  expect(result.rows.map((r) => r.rowIndex)).toEqual([2, 10, 5, 3, 4]);
  expect([...result.exact].map((r) => r.rowIndex)).toEqual([2, 10]);
  expect(pickerRows(tab, 'weapon-trait', 'Alpha', 'Traits').rows.map((r) => r.rowIndex)).toEqual([
    2, 10, 5, 3,
  ]);
});
it('uses refreshed sheet names rather than an earlier source index', () => {
  const refreshed = {
    ...tab,
    rows: tab.rows.map((r) => (r.name === 'Alpha' ? { ...r, name: 'Gamma' } : r)),
  };
  expect(pickerRows(refreshed, 'weapon-trait', 'Gamma', '').rows.map((r) => r.rowIndex)).toEqual([
    2, 10,
  ]);
  expect(pickerRows(refreshed, 'weapon-trait', 'Alpha', '').exact.size).toBe(0);
});
