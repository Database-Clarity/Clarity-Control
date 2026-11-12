import { isMarkupOnly } from '@clarity/core';
import type { SaveEnricher } from './index';

export const bungie: SaveEnricher = async ({ before, next, item, user }) => {
  if (!item || user.role === 'translator') return next;
  // A tagging-only English edit (the lowered text is the same) reviews nothing against Bungie.
  const englishChanged =
    before?.text.en?.text !== next.text.en?.text &&
    !isMarkupOnly(before?.text.en?.text, next.text.en?.text ?? '');
  const explicitlyReviewed =
    JSON.stringify(before?.bungieSnapshot) !== JSON.stringify(next.bungieSnapshot);
  if (!englishChanged && !explicitlyReviewed) return next;
  return {
    ...next,
    bungieSnapshot: {
      description: item.inGameDescription,
      snapshotAt: new Date().toISOString(),
    },
  };
};
