import { expect, it } from 'vitest';
import { compendiumVisit } from './compendiumVisit';
import type { WorkThrough } from './useQueue';

it('opens the Compendium for a source change and once per parity run, the editor for a run on a phone', () => {
  const work = (source: string, mode = 'active') =>
    ({ mode, queue: { id: 'q1', source }, visit: {} }) as unknown as WorkThrough;
  const fromList = { pane: 'compendium' };
  expect(compendiumVisit(fromList, null, false)).toEqual({ id: fromList, view: 'compendium' });
  expect(compendiumVisit(fromList, null, true)).toEqual({ id: fromList, view: 'compendium' });
  expect(compendiumVisit({}, work('parity'), false)).toEqual({ id: 'q1', view: 'compendium' });
  expect(compendiumVisit({}, work('parity'), true)).toEqual({ id: 'q1', view: 'translation' });
  expect(compendiumVisit({}, work('drafts'), false)).toBeUndefined();
  expect(compendiumVisit(null, work('parity', 'paused'), false)).toBeUndefined();
  expect(compendiumVisit(null, null, false)).toBeUndefined();
});
