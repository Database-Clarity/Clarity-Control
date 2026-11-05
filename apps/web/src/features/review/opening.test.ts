// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  advanceReviewOpening,
  beginReviewOpening,
  requireReviewRows,
  retainReviewPage,
  useReviewOpening,
} from './opening';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  useReviewOpening.setState({ token: 0, warming: false, limit: Infinity, required: 0 });
});
afterEach(() => vi.unstubAllGlobals());

it('does not restart an already mounted page when its URL selection changes', () => {
  beginReviewOpening();
  const token = useReviewOpening.getState().token;
  const release = retainReviewPage();
  beginReviewOpening();
  expect(useReviewOpening.getState().token).toBe(token);
  release();
  release();
  beginReviewOpening();
  expect(useReviewOpening.getState().token).toBe(token + 1);
  expect(advanceReviewOpening(token)).toBe(true);
  expect(useReviewOpening.getState().warming).toBe(true);
});

it('waits for the final slice to paint and accommodates a larger window before activation', () => {
  beginReviewOpening();
  const token = useReviewOpening.getState().token;
  requireReviewRows(9);
  while (useReviewOpening.getState().limit < 9) expect(advanceReviewOpening(token)).toBe(false);
  expect(useReviewOpening.getState().warming).toBe(true);
  requireReviewRows(13);
  expect(advanceReviewOpening(token)).toBe(false);
  expect(useReviewOpening.getState().warming).toBe(true);
  expect(advanceReviewOpening(token)).toBe(true);
  expect(useReviewOpening.getState().warming).toBe(false);
});

it('finishes a phone opening that has no sidebar rows', () => {
  beginReviewOpening();
  expect(advanceReviewOpening(useReviewOpening.getState().token)).toBe(true);
  expect(useReviewOpening.getState().warming).toBe(false);
});
