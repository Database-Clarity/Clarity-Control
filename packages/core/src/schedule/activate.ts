import { merge3 } from '../merge3.js';
import { readNumberMap, reconcileNumberMap } from '../numbers/map.js';
import { stableStringify } from '../contentHash.js';
import { validateNumberTooltip } from '../validation/numbers.js';
import { boundTranslationSources } from './stamps.js';
import { type Tooltip } from '../schemas.js';
import {
  changedFields,
  fieldValue,
  isTranslationField,
  sameFieldValue,
  withField,
} from './fields.js';

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
  | { ok: false; fields: string[]; changed: string[]; reason?: string };

export type ActivationChoice = 'upcoming' | 'current';

/** Transfer a server-owned proposal chain without reallocating the ids its translations use. */
export function reconcileScheduledNumbers(
  base: Tooltip | null,
  source: Tooltip | null,
  proposed: Tooltip,
  tooltip: Tooltip,
): { ok: true; tooltip: Tooltip } | { ok: false; reason: string } {
  const english = tooltip.text.en;
  if (!english) return { ok: true, tooltip };
  const changedEnglish = !sameFieldValue('text.en', base?.text.en, proposed.text.en);
  const keepsProposal =
    changedEnglish &&
    english.text === proposed.text.en?.text &&
    sameFieldValue('text.en', source?.text.en, base?.text.en);
  const numbers = keepsProposal
    ? proposed.text.en?.numbers
    : source?.text.en?.text === english.text
      ? source.text.en.numbers
      : reconcileNumberMap(source?.text.en, english, tooltip);
  const stagedTokens = Object.entries(tooltip.text).some(
    ([lang, entry]) => lang !== 'en' && entry.text.includes('#{='),
  );
  if (
    changedEnglish &&
    !keepsProposal &&
    proposed.text.en &&
    stagedTokens &&
    stableStringify(readNumberMap({ text: english.text, numbers })) !==
      stableStringify(readNumberMap(proposed.text.en))
  )
    return {
      ok: false,
      reason: `Tooltip ${tooltip.hash}: English number identities changed; reload and re-pick the staged numbers`,
    };
  const en = { ...english };
  delete en.numbers;
  if (numbers) en.numbers = numbers;
  return { ok: true, tooltip: { ...tooltip, text: { ...tooltip.text, en } } };
}

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
  identityBase: Tooltip | null = base,
) {
  let from = current;
  let to = current;
  for (const field of changed) {
    const choice = choices[field] ?? (isTranslationField(field) ? 'upcoming' : undefined);
    if (choice === 'current') continue;
    // merge3 takes `to` whenever `from` equals current, so an unchosen field merges three ways
    // and a field forced upcoming takes the proposal outright. A current that differs from base
    // only in stamps counts as unchanged (stamp-only = no-op, R17).
    if (
      choice === undefined &&
      !sameFieldValue(field, fieldValue(base, field), fieldValue(current, field))
    )
      from = withField(from, base, field);
    to = withField(to, proposed, field);
  }
  const result = merge3(from, current, to);
  if (!result.ok) return result;
  const transfer = reconcileScheduledNumbers(identityBase, current, proposed, result.merged);
  if (!transfer.ok)
    return {
      ok: false as const,
      reason: transfer.reason,
      conflicts: [{ field: 'text.en', base: undefined, head: undefined, next: transfer.reason }],
    };
  result.merged = transfer.tooltip;
  const issues = validateNumberTooltip(result.merged, current);
  if (issues.length)
    return {
      ok: false as const,
      reason: `Tooltip ${proposed.hash} (${issues[0].lang}): ${issues[0].message}`,
      conflicts: issues.map((issue) => ({
        field: changed.includes(`text.${issue.lang}`) ? `text.${issue.lang}` : 'text.en',
        base: undefined,
        head: undefined,
        next: issue.message,
      })),
    };
  return result;
}

/**
 * Activation (batch → current saved), used unchanged at schedule time (clean = schedulable),
 * at the claim, and in RECORD. Existence follows save.ts:109-125 (R14): base null and current
 * absent creates; base null with a current, or a base with no current, is an `$exists` conflict.
 */
export function activate({ base, current, proposed }: ActivationInput): ActivationResult {
  const changed = changedFields(base, proposed);
  if ((base === null) !== (current === null)) return { ok: false, fields: [existsField], changed };
  const empty = { hash: proposed.hash, text: {}, associated: [] };
  const result = mergeChanged(base ?? empty, current ?? empty, proposed, changed);
  if (!result.ok)
    return {
      ok: false,
      fields: [...new Set(result.conflicts.map(({ field }) => field))],
      changed,
      ...('reason' in result ? { reason: String(result.reason) } : {}),
    };
  return {
    ok: true,
    tooltip: boundTranslationSources(result.merged),
    created: current === null,
    changed,
  };
}

export interface ResolutionInput extends ActivationInput {
  /** Per-field decisions; every conflicted field needs one, and only batch-changed fields may have one. */
  choices: Readonly<Record<string, ActivationChoice>>;
}

export type ResolutionResult =
  /** Write `tooltip` (null: leave the tooltip absent) and delete the conflict file. */
  | { ok: true; tooltip: Tooltip | null }
  /** 409: these fields conflict now and have no choice. */
  | { ok: false; missing: string[]; reason?: string };

/**
 * Resolution of an activation conflict (R4, R12) against current at the resolving head: merge
 * over ALL batch-changed fields; clean fields take the batch value, conflicted fields must have
 * a choice, and an explicit choice on any changed field is applied. Existence: base null with a
 * current merges against an empty base (current-only fields stay; fields both set differently
 * need choices; `$exists` is not a choice there). A base whose current is gone needs a choice
 * for `$exists`: 'upcoming' recreates it from the proposal, 'current' leaves it absent.
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
  if (base !== null && current === null) {
    const choice = choices[existsField];
    if (!choice) return { ok: false, missing: [existsField] };
    if (choice === 'current') return { ok: true, tooltip: null };
    const empty = { hash: proposed.hash, text: {}, associated: [] };
    const result = mergeChanged(empty, empty, proposed, changedFields(null, proposed), {}, base);
    return result.ok
      ? { ok: true, tooltip: result.merged }
      : {
          ok: false,
          missing: [...new Set(result.conflicts.map(({ field }) => field))],
          ...('reason' in result ? { reason: String(result.reason) } : {}),
        };
  }
  if (choices[existsField]) throw new Error('No existence choice applies here');
  const from = base ?? { hash: proposed.hash, text: {}, associated: [] };
  const result = mergeChanged(from, current ?? from, proposed, changed, choices);
  if (!result.ok)
    return {
      ok: false,
      missing: [...new Set(result.conflicts.map(({ field }) => field))],
      ...('reason' in result ? { reason: String(result.reason) } : {}),
    };
  return { ok: true, tooltip: result.merged };
}
