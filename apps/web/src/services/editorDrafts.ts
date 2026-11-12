import type { CompendiumData } from '@clarity/core';
import { z } from 'zod';

/**
 * Agent-written first drafts for empty tooltips ("Load draft"). They live on the
 * `editor-drafts` branch of Live-Clarity-Database (no workflow runs there): `index.json`
 * lists the hashes that have a draft, and `drafts/<hash>.json` holds one draft. The editor
 * reads the index once per session, after the workspace is ready, and a draft only when its
 * tooltip opens empty. Nothing here writes; a loaded draft is an ordinary local edit.
 * The format is documented in apps/web/README.md ("Draft loader").
 */
const source =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-drafts';
const hashSchema = z.number().int().nonnegative().max(0xffffffff);

export const editorDraftIndexSchema = z.object({
  schemaVersion: z.literal(1),
  hashes: z.array(hashSchema).max(20000),
});
export const editorDraftSchema = z.object({
  schemaVersion: z.literal(1),
  hash: hashSchema,
  /** The draft's English Clarity markup. */
  english: z.string().min(1).max(20000),
  /** The Compendium-data commit the source text was read from (provenance). */
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  source: z.object({
    tab: z.string().min(1),
    gid: z.string().regex(/^-?\d+$/),
    /** A1 range(s) in the sheet: `C12`, `C12:E14`, or several joined by `, `. */
    range: z
      .string()
      .regex(/^[A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?(?:, [A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?)*$/),
    /** The source's text when the draft was written: its fingerprint (see rangeText). */
    text: z.string(),
  }),
  /** Version of the owner's style guide the draft was written with. */
  styleGuide: z.string().min(1).max(64),
  createdAt: z.string().datetime({ offset: true }),
  model: z.string().min(1).max(64),
});
export type EditorDraft = z.infer<typeof editorDraftSchema>;

type Fetcher = (path: string) => Promise<Response>;
const network: Fetcher = (path) =>
  fetch(`${source}/${path}`, { credentials: 'omit', cache: 'no-cache' });
let fetcher: Fetcher = network;
let index: Promise<ReadonlySet<number>> | undefined;
let known: ReadonlySet<number> | undefined;
const drafts = new Map<number, Promise<EditorDraft | null>>();

/** Tests and browser fixtures supply their own files; `undefined` restores the network. */
export function setEditorDraftFetch(next: Fetcher | undefined) {
  fetcher = next ?? network;
  index = undefined;
  known = undefined;
  drafts.clear();
}

/** Hashes with a draft. One request per session; a failure (offline, no branch) is an empty set. */
export function editorDraftIndex(): Promise<ReadonlySet<number>> {
  index ??= (async () => {
    try {
      const response = await fetcher('index.json');
      known = response.ok
        ? new Set(editorDraftIndexSchema.parse(await response.json()).hashes)
        : new Set<number>();
    } catch {
      known = new Set<number>();
    }
    return known;
  })();
  return index;
}

/** The index if it has already arrived (no request). */
export function knownDraftIndex() {
  return known;
}

/** One tooltip's draft, or null (none, failed, or not for this hash). Cached per session. */
export function editorDraft(hash: number): Promise<EditorDraft | null> {
  let found = drafts.get(hash);
  if (!found) {
    found = (async () => {
      try {
        const response = await fetcher(`drafts/${hash}.json`);
        if (!response.ok) return null;
        const draft = editorDraftSchema.parse(await response.json());
        return draft.hash === hash ? draft : null;
      } catch {
        return null;
      }
    })();
    drafts.set(hash, found);
    // A failure is not remembered: the next open of the tooltip asks again.
    void found.then((draft) => {
      if (!draft && drafts.get(hash) === found) drafts.delete(hash);
    });
  }
  return found;
}

/** `C12` -> { row: 12, col: 2 } (rows 1-based, columns 0-based, as in the Compendium grid). */
function cellAddress(a1: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(a1);
  if (!match) return undefined;
  let col = 0;
  for (const letter of match[1]) col = col * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]), col: col - 1 };
}

/**
 * The text of a range in the current Compendium: the non-blank cells inside it in reading order
 * (row by row, left to right; a merged cell once, at its top-left), their plain text joined by
 * newlines. Undefined when the tab or every cell of the range is gone.
 */
export function rangeText(data: CompendiumData, gid: string, range: string): string | undefined {
  const sheet = data.tabs.find((tab) => tab.gid === gid);
  if (!sheet?.grid) return undefined;
  const parts: string[] = [];
  for (const region of range.split(', ')) {
    const [from, to = from] = region.split(':').map(cellAddress);
    if (!from || !to) return undefined;
    parts.push(
      ...sheet.grid
        .filter(
          (cell) =>
            cell.row >= from.row &&
            cell.row <= to.row &&
            cell.col >= from.col &&
            cell.col <= to.col &&
            cell.cell.plain.trim(),
        )
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .map((cell) => cell.cell.plain),
    );
  }
  return parts.length ? parts.join('\n') : undefined;
}

const normalised = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether the draft's Compendium source reads differently now; undefined while unknown. */
export function sourceChanged(draft: EditorDraft, data: CompendiumData | null) {
  if (!data) return undefined;
  const now = rangeText(data, draft.source.gid, draft.source.range);
  return now === undefined || normalised(now) !== normalised(draft.source.text);
}
