import { expect, it } from 'vitest';
import { errorMessage } from './http';

it('turns raw browser fetch failures into a plain retry message', () => {
  for (const raw of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch']) {
    expect(errorMessage(new TypeError(raw))).toMatch(/Could not reach the server.*retry/);
  }
  expect(errorMessage(new Error('HTTP 500'))).toBe('HTTP 500');
  expect(errorMessage(new TypeError('x is not a function'))).toBe('x is not a function');
});
