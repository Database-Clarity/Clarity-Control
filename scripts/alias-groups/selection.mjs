import { isDeepStrictEqual } from 'node:util';

export const membershipKey = (members) => [...members].sort((a, b) => a - b).join(',');

// Edit history does not make two complete documents conflict. Keep every
// association, publication flag, archive field, and other document fact.
export function sameDocumentMetadata(a, b, ignoreEditHistory = false) {
  const metadata = (tooltip) => {
    if (!tooltip) return null;
    const rest = structuredClone(tooltip);
    delete rest.hash;
    delete rest.text;
    if (ignoreEditHistory && rest.legacy) {
      delete rest.legacy.updateTracker;
      if (!Object.keys(rest.legacy).length) delete rest.legacy;
    }
    return rest;
  };
  return isDeepStrictEqual(metadata(a), metadata(b));
}

export function uniqueProposals(proposals) {
  const groups = new Map();
  for (const proposal of proposals) {
    const key = membershipKey(proposal.members);
    // A same-category proposal already represents the identical membership;
    // an additional cross-category proposal adds no owner decision.
    if (!groups.has(key) || (groups.get(key).kind === 'X' && proposal.kind === 'S'))
      groups.set(key, proposal);
  }
  return [...groups.values()];
}
