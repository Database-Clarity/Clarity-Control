import { beforeEach, describe, expect, it, vi } from 'vitest';

const pending = vi.hoisted(() => [] as ((value: unknown[]) => void)[]);
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  fetchTooltipReports: () => new Promise((resolve) => pending.push(resolve)),
}));

import { reportsKey, useTooltipReports } from './reportsCache';

beforeEach(() => {
  pending.length = 0;
  useTooltipReports.getState().setOwner(null);
});

describe('report bodies cache', () => {
  it('a response for a signed-out or other session never fills the new one', async () => {
    useTooltipReports.getState().setOwner('1:maintainer::a');
    const load = useTooltipReports.getState().load(42, 'en');
    // Sign-out (or another account) clears the cache before the old response lands.
    useTooltipReports.getState().setOwner(null);
    pending[0]!([]);
    await load;
    expect(useTooltipReports.getState().entries[reportsKey(42, 'en')]).toBeUndefined();
  });

  it('keeps entries for the same session and clears them for another', async () => {
    useTooltipReports.getState().setOwner('1:maintainer::a');
    const load = useTooltipReports.getState().load(42, 'en');
    pending[0]!([]);
    await load;
    expect(useTooltipReports.getState().entries[reportsKey(42, 'en')]?.reports).toEqual([]);
    useTooltipReports.getState().setOwner('1:maintainer::a');
    expect(useTooltipReports.getState().entries[reportsKey(42, 'en')]).toBeDefined();
    useTooltipReports.getState().setOwner('1:translator:de:b');
    expect(useTooltipReports.getState().entries).toEqual({});
  });
});
