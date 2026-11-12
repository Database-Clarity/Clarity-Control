import * as z from 'zod/mini';

const catalogItemSchema = z.object({
  owner: z.int().check(z.nonnegative()),
  langs: z.array(z.string()),
  variant: z.string(),
  name: z.string(),
  icon: z.string(),
  category: z.string(),
  type: z.string(),
});
export type ReportCatalogItem = z.infer<typeof catalogItemSchema>;
export const reportCatalogSchema = z.object({
  v: z.literal(1),
  sourceCommit: z.string().check(z.regex(/^[a-f0-9]{40}$/)),
  items: z.record(z.string(), catalogItemSchema),
});
export type ReportCatalog = z.infer<typeof reportCatalogSchema>;
