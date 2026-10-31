import { z } from 'zod';

export const compendiumStyleSchema = z
  .object({
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
    parts: z.array(z.string()).optional(),
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

export function normaliseRuns(runs: CompendiumRun[]): CompendiumCell {
  const merged: CompendiumRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = merged.at(-1);
    if (last && styleKey(last) === styleKey(run)) last.text += run.text;
    else merged.push({ ...run });
  }
  return { plain: merged.map((run) => run.text).join(''), runs: merged };
}

export function sameCell(a: CompendiumCell, b: CompendiumCell): boolean {
  const left = normaliseRuns(a.runs);
  const right = normaliseRuns(b.runs);
  return (
    left.plain === right.plain &&
    left.runs.length === right.runs.length &&
    left.runs.every(
      (run, i) => run.text === right.runs[i].text && styleKey(run) === styleKey(right.runs[i]),
    )
  );
}
