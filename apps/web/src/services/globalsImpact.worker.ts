import { calculateGlobalImpact } from '../../../../packages/core/src/globals/impact';
import type { GlobalsImpactReply, GlobalsImpactRequest } from './globals';

// Display-only projection. The authoritative saved ledger is materialized by Actions.
self.onmessage = (event: MessageEvent<GlobalsImpactRequest>) => {
  const { id, input } = event.data;
  let reply: GlobalsImpactReply;
  try {
    reply = {
      id,
      result: calculateGlobalImpact(input.before, input.after, input.changes, input.destination),
    };
  } catch (error) {
    reply = { id, error: error instanceof Error ? error.message : 'Projected calculation failed.' };
  }
  self.postMessage(reply);
};
