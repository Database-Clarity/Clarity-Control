import { z } from 'zod';
import { draftsSchema, type Drafts } from '../../services/draftStorage';

/** The payload one origin hands another: drafts per storage bucket plus device preferences. */
export const snapshotVersion = 1;
/** postMessage payload cap, in characters of JSON. Larger snapshots go through a file instead. */
export const maxMessageChars = 6 * 1024 * 1024;
/** Cap for an imported file (the escape hatch for what the message cannot carry). */
export const maxFileChars = 48 * 1024 * 1024;
export const maxPrefValueChars = 1024 * 1024;

/** `tooltips` is the signed-out bucket; `tooltips:user:<id>` is one account's. */
export const bucketPattern = /^tooltips(:user:[A-Za-z0-9_-]{1,64})?$/;
export const unownedBucket = 'tooltips';

/**
 * Device preference keys that may move. Anything else is refused on receipt, so a snapshot can
 * never write a session token, a sign-in marker, or any other key the app trusts.
 */
export const prefPrefixes = [
  'clarity-settings:',
  'description-editor-split',
  'clarity-preview-review:v1:',
  'clarity-conflicts:v1:',
  'clarity-lost-text:v1:',
  'clarity-compendium-tab:',
  'clarity-compendium-review:v1:',
  'clarity-review-guidance:v1:',
  'clarity-suggest-recent:v1',
] as const;
export const isMovablePref = (key: string) => prefPrefixes.some((prefix) => key.startsWith(prefix));

export const snapshotSchema = z.object({
  version: z.literal(snapshotVersion),
  buckets: z.record(z.string().regex(bucketPattern), draftsSchema),
  prefs: z.record(z.string().max(200), z.string().max(maxPrefValueChars)),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export type ParseResult = { ok: true; snapshot: Snapshot } | { ok: false; message: string };

/** Size-checks the raw text BEFORE parsing it, then validates; unknown or unsafe keys are dropped. */
export function parseSnapshot(text: unknown, maxChars: number): ParseResult {
  if (typeof text !== 'string') return { ok: false, message: 'The data is not text.' };
  if (text.length > maxChars)
    return {
      ok: false,
      message: `The data is too large (${(text.length / 1048576).toFixed(1)} MB, limit ${Math.floor(maxChars / 1048576)} MB). Use Export file instead.`,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The data is not valid JSON.' };
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'The data is not a valid draft snapshot.' };
  const prefs = Object.fromEntries(
    Object.entries(parsed.data.prefs).filter(([key]) => isMovablePref(key)),
  );
  return { ok: true, snapshot: { ...parsed.data, prefs } };
}

/** Serializes a snapshot; an over-cap one is refused with a message instead of being sent. */
export function serializeSnapshot(
  snapshot: Snapshot,
  maxChars: number,
): ParseResult & { text?: string } {
  const text = JSON.stringify(snapshot);
  const checked = parseSnapshot(text, maxChars);
  return checked.ok ? { ...checked, text } : checked;
}

export const draftCount = (snapshot: Snapshot) =>
  Object.values(snapshot.buckets).reduce((sum, drafts) => sum + Object.keys(drafts).length, 0);

export type { Drafts };
