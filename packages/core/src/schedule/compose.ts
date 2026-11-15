import { merge3 } from '../merge3.js';
import { reconcileScheduledNumbers } from './activate.js';
import { validateNumberTooltip } from '../validation/numbers.js';
import { tooltipSchema, type Tooltip } from '../schemas.js';
import { boundTranslationSources } from './stamps.js';
import { changedFields, fieldValue, sameFieldValue, withField } from './fields.js';

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
  /**
   * C1-C2: the published snapshot with every batch-changed field taken from the proposal, except
   * `associated` (non-null base), which applies the batch's additions and removals to the
   * snapshot with merge3's set rule, exactly as activation applies them to current.
   * `unpublished`: changed fields whose base (current saved at add or rebase) differed from the
   * snapshot, so the batch value also carries saved-but-unpublished work on that field, or
   * reverts a field live moved past base. P3 shows them to the approver; whether P4 refuses
   * them is root's call (see README). `associated` appears only with a null base.
   */
  | { status: 'overlay'; tooltip: Tooltip; changed: string[]; unpublished: string[] }
  /** C4: never published (no pushed entry, no snapshot): the whole proposal publishes. */
  | { status: 'whole'; tooltip: Tooltip; changed: string[] }
  /** C3: pushed but no snapshot; refuse so saved-unpublished work never leaks (I3). */
  | { status: 'stale'; reason: string };

/** merge3's association set merge (it never conflicts) of base → proposed onto `onto`. */
function mergeAssociations(base: Tooltip, onto: Tooltip, proposed: Tooltip): number[] {
  const only = (tooltip: Tooltip): Tooltip => ({
    hash: tooltip.hash,
    text: {},
    associated: tooltip.associated,
  });
  const result = merge3(only(base), only(onto), only(proposed));
  if (!result.ok) throw new Error('Association merge cannot conflict');
  return result.merged.associated;
}

export const missingSnapshotReason = 'No published snapshot; publish it manually first or rebase';

/**
 * What a batch publishes for one member (spec "Composition", I3). Never reads current saved
 * data: unrelated saved-but-unpublished work on the tooltip stays out of live.
 * The publisher defers source bounding until it has selected the final English stamps.
 */
export function compose(input: ComposeInput, boundSources = true): ComposeResult {
  const { hash, base, proposed, snapshot, pushed } = input;
  for (const tooltip of [base, proposed, snapshot])
    if (tooltip && tooltipSchema.parse(tooltip).hash !== hash)
      throw new Error(`Tooltip does not belong to member ${hash}`);
  const changed = changedFields(base, proposed);
  let tooltip = proposed;
  let unpublished: string[] = [];
  if (snapshot) {
    tooltip = snapshot;
    for (const field of changed)
      tooltip =
        field === 'associated' && base
          ? { ...tooltip, associated: mergeAssociations(base, snapshot, proposed) }
          : withField(tooltip, proposed, field);
    unpublished = changed.filter(
      (field) =>
        !(field === 'associated' && base) &&
        !sameFieldValue(
          field,
          base ? fieldValue(base, field) : undefined,
          fieldValue(snapshot, field),
        ),
    );
  } else if (pushed) return { status: 'stale', reason: missingSnapshotReason };
  // Composition uses the published source; activation separately reconciles against current.
  // Never let a proposal's cached map renumber the snapshot's translations.
  const head = snapshot ?? base;
  const transfer = reconcileScheduledNumbers(base, head, proposed, tooltip);
  if (!transfer.ok) return { status: 'stale', reason: transfer.reason };
  tooltip = transfer.tooltip;
  const issue = validateNumberTooltip(tooltip, head)[0];
  if (issue)
    return { status: 'stale', reason: `Tooltip ${hash} (${issue.lang}): ${issue.message}` };
  tooltip = boundSources
    ? boundTranslationSources(tooltipSchema.parse(tooltip))
    : tooltipSchema.parse(tooltip);
  if (snapshot) return { status: 'overlay', tooltip, changed, unpublished };
  return {
    status: 'whole',
    tooltip,
    changed,
  };
}
