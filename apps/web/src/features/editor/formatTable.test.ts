import { expect, test } from 'vitest';
import { formatMarkupTables } from './formatTable';

test('aligning tables keeps row-level markup placed before the first "|"', () => {
  const input = '< table x >\n<background/>| a |b longer cell\n| c | d\n<$>';
  const formatted = formatMarkupTables(input);
  expect(formatted.split('\n')[1]).toMatch(/^<background\/>\|/);
  expect(formatted).toContain('<background/>');
  expect(formatMarkupTables(formatted)).toBe(formatted);
});
