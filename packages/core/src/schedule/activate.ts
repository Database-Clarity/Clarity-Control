import { merge3 } from '../merge3.js';
import { type Tooltip } from '../schemas.js';
import { changedFields, isTranslationField, withField } from './fields.js';

/** The existence conflict save.ts reports (base and current disagree on whether the tooltip exists). */
export const existsField = '$exists';

export interface ActivationInput {
  /** The member's base at the claim commit S' (null: the batch creates the tooltip). */
  base: Tooltip | null;
  /** Current saved tooltip at the RECORD head H (null: absent). */
  current: Tooltip | null;
  /** The member's proposal at S'. */
  proposed: Tooltip;
}

export type ActivationResult =
  /** Write `tooltip` to tooltips/<hash>.json (`created`: it was absent). */
  | { ok: true; tooltip: Tooltip; created: boolean; changed: string[] }
  /** Keep current entirely; `fields` are the conflicted fields, `changed` all batch-changed ones. */
  | { ok: false; fields: string[]; changed: string[] };

export type ActivationChoice = 'upcoming' | 'current';

/**
 * Field-level merge3 restricted to the batch-changed fields (I4): for a changed field F, base_F →
 * proposed_F is merged against current_F with merge3's exact rules (atomic, stamped, the
 * associations set merge); every field the batch did not change keeps current. Q4: a translation
 * the batch changed takes the upcoming value even if current changed meanwhile.
 * `choices` (resolution, R12) force a changed field to the upcoming or the current value.
 */
function mergeChanged(
  base: Tooltip,
  current: Tooltip,
  proposed: Tooltip,
  changed: readonly string[],
  choices: Readonly<Record<string, ActivationChoice>> = {},
) {
  let from = current;
  let to = current;
  for (const field of changed) {
    const choice = choices[field] ?? (isTranslationField(field) ? 'upcoming' : undefined);
    if (choice === 'current') continue;
    // merge3 takes `to` whenever `from` equals current, so an unchosen field merges three ways
    // and a field forced upcoming takes the proposal outright.
    if (choice === undefined) from = withField(from, base, field);
    to = withField(to, proposed, field);
  }
  return merge3(from, current, to);
}

/**
 * Activation (batch → current saved), used unchanged at schedule time (clean = schedulable),
 * at the claim, and in RECORD. Existence follows save.ts:109-125 (R14): base null and current
 * absent creates; base null with a current, or a base with no current, is an `$exists` conflict.
 */
export function activate({ base, current, proposed }: ActivationInput): ActivationResult {
  const changed = changedFields(base, proposed);
  if (base === null && current === null)
    return { ok: true, tooltip: proposed, created: true, changed };
  if (base === null || current === null) return { ok: false, fields: [existsField], changed };
  const result = mergeChanged(base, current, proposed, changed);
  if (!result.ok) return { ok: false, fields: result.conflicts.map(({ field }) => field), changed };
  return { ok: true, tooltip: result.merged, created: false, changed };
}

export interface ResolutionInput extends ActivationInput {
  /** Per-field decisions; every conflicted field needs one, and only batch-changed fields may have one. */
  choices: Readonly<Record<string, ActivationChoice>>;
}

export type ResolutionResult =
  /** Write `tooltip` (null: leave the tooltip absent) and delete the conflict file. */
  | { ok: true; tooltip: Tooltip | null }
  /** 409: these fields conflict now and have no choice. */
  | { ok: false; missing: string[] };

/**
 * Resolution of an activation conflict (R4, R12) against current at the resolving head: merge
 * over ALL batch-changed fields; clean fields take the batch value, conflicted fields must have
 * a choice, and an explicit choice on any changed field is applied. An `$exists` conflict takes
 * a choice for `$exists`: 'upcoming' writes the whole proposal, 'current' keeps current.
 */
export function resolveActivation({
  base,
  current,
  proposed,
  choices,
}: ResolutionInput): ResolutionResult {
  const changed = changedFields(base, proposed);
  const allowed = new Set([...changed, existsField]);
  const unknown = Object.keys(choices).filter((field) => !allowed.has(field));
  if (unknown.length)
    throw new Error(`Choices for fields the batch does not change: ${unknown.join(', ')}`);
  for (const [field, choice] of Object.entries(choices))
    if (choice !== 'upcoming' && choice !== 'current')
      throw new Error(`Invalid choice for ${field}`);
  if (base === null && current === null) {
    return { ok: true, tooltip: choices[existsField] === 'current' ? null : proposed };
  }
  if (base === null || current === null) {
    const choice = choices[existsField];
    if (!choice) return { ok: false, missing: [existsField] };
    return { ok: true, tooltip: choice === 'upcoming' ? proposed : current };
  }
  if (choices[existsField]) throw new Error('No existence conflict to resolve');
  const result = mergeChanged(base, current, proposed, changed, choices);
  if (!result.ok) return { ok: false, missing: result.conflicts.map(({ field }) => field) };
  return { ok: true, tooltip: result.merged };
}
