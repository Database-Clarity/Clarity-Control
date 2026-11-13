import { tooltipSchema, type Tooltip } from '../schemas.js';
import { changedFields, withField } from './fields.js';

export interface ComposeInput {
  hash: number;
  /** The member's base (null: the batch creates the tooltip). */
  base: Tooltip | null;
  proposed: Tooltip;
  /** live/tooltips/<hash>.json at S, if present. */
  snapshot: Tooltip | null;
  /** Whether pushed.json has an entry for the hash at S. */
  pushed: boolean;
}

export type ComposeResult =
  /** C1-C2: the published snapshot with every batch-changed field taken from the proposal. */
  | { status: 'overlay'; tooltip: Tooltip; changed: string[] }
  /** C4: never published, or created by the batch: the whole proposal publishes. */
  | { status: 'whole'; tooltip: Tooltip; changed: string[] }
  /** C3: pushed but no snapshot; refuse so saved-unpublished work never leaks (I3). */
  | { status: 'stale'; reason: string };

export const missingSnapshotReason = 'No published snapshot; publish it manually first or rebase';

/**
 * What a batch publishes for one member (spec "Composition", I3). Never reads current saved
 * data: unrelated saved-but-unpublished work on the tooltip stays out of live.
 */
export function compose(input: ComposeInput): ComposeResult {
  const { hash, base, proposed, snapshot, pushed } = input;
  for (const tooltip of [base, proposed, snapshot])
    if (tooltip && tooltipSchema.parse(tooltip).hash !== hash)
      throw new Error(`Tooltip does not belong to member ${hash}`);
  const changed = changedFields(base, proposed);
  if (base === null) return { status: 'whole', tooltip: proposed, changed };
  if (snapshot) {
    let tooltip = snapshot;
    for (const field of changed) tooltip = withField(tooltip, proposed, field);
    return { status: 'overlay', tooltip: tooltipSchema.parse(tooltip), changed };
  }
  if (pushed) return { status: 'stale', reason: missingSnapshotReason };
  return { status: 'whole', tooltip: proposed, changed };
}
