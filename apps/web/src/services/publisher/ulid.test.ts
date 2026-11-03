import { publishMonth, publishOpIdSchema } from '@clarity/core';
import { expect, it } from 'vitest';
import { newOpId } from './ulid';

it('creates opIds the Worker accepts, dated by their own time', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  for (let n = 0; n < 200; n++) {
    const id = newOpId(now);
    expect(publishOpIdSchema.safeParse(id).success).toBe(true);
    expect(publishMonth(id)).toBe('2026-11');
  }
});

it('sorts by time and does not repeat', () => {
  const early = newOpId(Date.UTC(2026, 0, 1));
  const late = newOpId(Date.UTC(2026, 11, 31));
  expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true);
  expect(new Set(Array.from({ length: 500 }, () => newOpId(1))).size).toBe(500);
});

it('uses every byte uniformly (32 divides 256)', () => {
  const id = newOpId(0, (bytes) => bytes.fill(255));
  expect(id.slice(10)).toBe('Z'.repeat(16));
});
