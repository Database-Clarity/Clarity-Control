import { expect, it } from 'vitest';
import { compendiumVisit } from './compendiumVisit';
import type { WorkThrough } from './useQueue';

it('opens the Compendium for a source change and once per parity run, but not for a run on a phone', () => {
  const work = (source: string, mode = 'active') =>
    ({ mode, queue: { id: 'q1', source }, visit: {} }) as unknown as WorkThrough;
  const fromList = { pane: 'compendium' };
  expect(compendiumVisit(fromList, null, false)).toBe(fromList);
  expect(compendiumVisit(fromList, null, true)).toBe(fromList);
  expect(compendiumVisit({}, work('parity'), false)).toBe('q1');
  expect(compendiumVisit({}, work('parity'), true)).toBeUndefined();
  expect(compendiumVisit({}, work('drafts'), false)).toBeUndefined();
  expect(compendiumVisit(null, work('parity', 'paused'), false)).toBeUndefined();
  expect(compendiumVisit(null, null, false)).toBeUndefined();
});
