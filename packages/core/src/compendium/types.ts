import { z } from 'zod';

export const compendiumStyleSchema = z
  .object({
    // Carried on runs so concatenated source cells retain their own line alignment.
    textAlign: z.enum(['left', 'center', 'right', 'justify', 'start', 'end']).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/)
      .optional(),
    bold: z.literal(true).optional(),
    italic: z.literal(true).optional(),
    underline: z.literal(true).optional(),
    strike: z.literal(true).optional(),
    sizePt: z.number().positive().max(200).optional(),
    href: z
      .string()
      .url()
      .refine((value) => /^(https?:|mailto:)/.test(value))
      .optional(),
  })
  .strict();
export const compendiumRunSchema = compendiumStyleSchema.extend({ text: z.string() });
export const compendiumCellSchema = z
  .object({
    plain: z.string(),
    runs: z.array(compendiumRunSchema),
    // The cell's own background in the source sheet. Display only: never part of the cell's
    // identity (sameCell ignores it) and never stored in a link snapshot.
    background: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .optional(),
  })
  .strict()
  .refine(
    (cell) => cell.runs.map((run) => run.text).join('') === cell.plain,
    'Compendium plain text must match its runs',
  );
export const compendiumTabSchema = z.object({ gid: z.string().regex(/^-?\d+$/), name: z.string() });
export const compendiumPositionSchema = z.object({
  row: z.number().int().min(1).max(20000),
  col: z.number().int().min(0).max(255),
});
export const compendiumGridCellSchema = compendiumPositionSchema.extend({
  rowSpan: z.number().int().min(1).max(256).optional(),
  colSpan: z.number().int().min(1).max(256).optional(),
  cell: compendiumCellSchema,
});
export const compendiumCellOffsetSchema = z
  .object({
    dRow: z.number().int().min(-20000).max(20000),
    dCol: z.number().int().min(-255).max(255),
  })
  .strict();
export const compendiumCellOffsetsSchema = z
  .array(compendiumCellOffsetSchema)
  .min(1)
  .max(256)
  .refine(
    (cells) => new Set(cells.map(({ dRow, dCol }) => `${dRow}:${dCol}`)).size === cells.length,
    'Description cells must be distinct',
  );
export const compendiumRowSchema = z.object({
  name: z.string(),
  nameNorm: z.string(),
  section: z.string().optional(),
  rowIndex: z.number().int().positive(),
  anchor: compendiumPositionSchema.optional(),
  cell: compendiumCellSchema,
});
export const compendiumSheetSchema = z.object({
  gid: z.string().regex(/^-?\d+$/),
  name: z.string(),
  rows: z.array(compendiumRowSchema),
  grid: z.array(compendiumGridCellSchema).optional(),
});
export const compendiumDataSchema = z.object({
  fetchedAt: z.string().datetime({ offset: true }),
  tabs: z.array(compendiumSheetSchema),
});
export const compendiumLinkSchema = z
  .object({
    gid: z.string().regex(/^-?\d+$/),
    rowKey: z.string().min(1),
    section: z.string().optional(),
    snapshot: compendiumCellSchema,
    snapshotAt: z.string().datetime({ offset: true }),
    cells: compendiumCellOffsetsSchema.optional(),
    sourceAnchor: compendiumPositionSchema.optional(),
    parts: z.array(z.string()).optional(),
    setBonusPieces: z.union([z.literal(2), z.literal(4)]).optional(),
  })
  .strict();
export type CompendiumStyle = z.infer<typeof compendiumStyleSchema>;
export type CompendiumRun = z.infer<typeof compendiumRunSchema>;
export type CompendiumCell = z.infer<typeof compendiumCellSchema>;
export type CompendiumTab = z.infer<typeof compendiumTabSchema>;
export type CompendiumRow = z.infer<typeof compendiumRowSchema>;
export type CompendiumSheet = z.infer<typeof compendiumSheetSchema>;
export type CompendiumData = z.infer<typeof compendiumDataSchema>;
export type CompendiumLink = z.infer<typeof compendiumLinkSchema>;
export type CompendiumPosition = z.infer<typeof compendiumPositionSchema>;
export type CompendiumGridCell = z.infer<typeof compendiumGridCellSchema>;
export type CompendiumCellOffset = z.infer<typeof compendiumCellOffsetSchema>;

export function styleKey(run: CompendiumRun): string {
  return JSON.stringify(
    Object.entries(run)
      .filter(([key]) => key !== 'text')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Values whose JSON text differs whenever the values differ (`!==`). */
function distinctJson(value: unknown) {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Exactly `styleKey(a) === styleKey(b)`, which matching evaluates many thousand
 * times. styleKey serializes the sorted [key, value] pairs except text, so:
 * the same keys in the same order with identical values serialize identically;
 * a key only one run has, or a key whose values serialize differently,
 * cannot. Only other pairs pay for the serialized comparison.
 */
function sameStyle(a: CompendiumRun, b: CompendiumRun): boolean {
  const left = Object.keys(a) as (keyof CompendiumRun)[];
  const right = Object.keys(b) as (keyof CompendiumRun)[];
  if (left.length === right.length) {
    let identical = true;
    for (let i = 0; i < left.length && identical; i++) {
      const key = left[i];
      identical = key === right[i] && (key === 'text' || a[key] === b[key]);
    }
    if (identical) return true;
  }
  let shared = 0;
  for (const key of left) {
    if (key === 'text') continue;
    if (!right.includes(key)) return false;
    shared++;
    if (a[key] !== b[key] && distinctJson(a[key]) && distinctJson(b[key])) return false;
  }
  if (shared !== right.length - (right.includes('text') ? 1 : 0)) return false;
  return styleKey(a) === styleKey(b);
}

export function normaliseRuns(runs: CompendiumRun[]): CompendiumCell {
  const merged: CompendiumRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = merged.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  return { plain: merged.map((run) => run.text).join(''), runs: merged };
}

/** The cell with the sheet background set (or removed when none). */
export function withBackground(cell: CompendiumCell, background?: string): CompendiumCell {
  const rest: CompendiumCell = { plain: cell.plain, runs: cell.runs };
  return background ? { ...rest, background } : rest;
}

/** evidenceCell(cell).plain without building the normalized cell. */
function evidenceText(cell: CompendiumCell): string {
  let text = '';
  for (const run of cell.runs) if (run.text) text += run.text;
  return text;
}

export function sameCell(a: CompendiumCell, b: CompendiumCell): boolean {
  // These shortcuts decide exactly what the full comparison below would decide:
  // evidenceCell reads only runs and is deterministic (withBackground shares runs),
  // and its plain text is the non-empty run text.
  if (a === b || a.runs === b.runs) return true;
  if (evidenceText(a) !== evidenceText(b)) return false;
  const left = evidenceCell(a);
  const right = evidenceCell(b);
  return (
    left.plain === right.plain &&
    left.runs.length === right.runs.length &&
    left.runs.every((run, i) => run.text === right.runs[i].text && sameStyle(run, right.runs[i]))
  );
}

/** Sheet background and paragraph alignment are display-only; all other run styles remain strict. */
export function evidenceCell(cell: CompendiumCell): CompendiumCell {
  // Rest copy: the same keys in the same order as spread + delete, without
  // turning every copy into a slow dictionary-mode object.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return normaliseRuns(cell.runs.map(({ textAlign, ...copy }) => copy));
}
