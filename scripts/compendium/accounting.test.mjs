import { expect, it } from 'vitest';
import { countActions } from '../compendium-guidance/accounting.mjs';

it('counts no-equivalent decisions separately from links', () => {
  expect(
    countActions([
      {
        entries: [
          { confidence: 'high', action: 'link' },
          { confidence: 'high', action: 'no-equivalent' },
          { confidence: 'medium', action: 'link' },
          { confidence: 'unresolved', action: 'owner' },
        ],
      },
    ]),
  ).toEqual({ linked: 2, highLinks: 1, highNoEquivalent: 1 });
});

