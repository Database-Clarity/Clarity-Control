import { langSchema } from '../../../../packages/core/src/languages';
import {
  reportCategorySchema,
  reportIdSchema,
  reportStatusSchema,
  type ReportSubmission,
} from '../../../../packages/core/src/reports/schemas';
import { z } from 'zod';
import { call } from './reports';

/**
 * The reporter's own report routes (apps/worker/src/reports.ts): submit, receipt, view, withdraw,
 * My reports, and screenshot upload. They read the shared report schemas, so the public page
 * loads this module only when one of them runs (services/reports.ts holds the first-paint reads).
 */

const receiptSchema = z.object({
  status: reportStatusSchema,
  closed_note: z.string().nullable(),
});
export type ReportReceipt = z.infer<typeof receiptSchema>;

const reporterNoteSchema = z.object({
  n: z.number().int(),
  category: reportCategorySchema,
  text: z.string(),
  exact: z.string().nullable(),
  start: z.number().int().nullable(),
  end: z.number().int().nullable(),
  whole: z.number().int(),
});
const reporterDetailSchema = z
  .object({
    id: reportIdSchema,
    owner_hash: z.number().int(),
    viewed_hash: z.number().int(),
    variant: z.string(),
    lang: langSchema,
    seen_lang: langSchema.nullable(),
    status: reportStatusSchema,
    category: reportCategorySchema,
    note: z.string(),
    created_at: z.number(),
    updated_at: z.number(),
    closed_note: z.string().nullable(),
    files_count: z.number().int(),
    notes: z.array(reporterNoteSchema),
  })
  .passthrough();
export type ReporterDetail = z.infer<typeof reporterDetailSchema>;

const mineSchema = z.array(
  z.object({
    id: reportIdSchema,
    status: reportStatusSchema,
    owner_hash: z.number().int(),
    lang: langSchema,
    created_at: z.number(),
    updated_at: z.number(),
    closed_note: z.string().nullable(),
  }),
);
export type MyReport = z.infer<typeof mineSchema>[number];

export type ReportPayload = Omit<ReportSubmission, 'turnstile'> & { turnstile?: string };
const submittedSchema = z.object({ id: reportIdSchema, status: reportStatusSchema });

/** Files a report. A retry with the same request id returns the stored `{id, status}`. */
export function submitReport(payload: ReportPayload) {
  return call('/reports', submittedSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Status and the editors' closing note: needs nothing but the id. */
export function reportReceipt(id: string, signal?: AbortSignal) {
  return call(`/reports/r/${id}`, receiptSchema, { signal, auth: false });
}

/** The reporter's own copy: by session, or by the withdraw secret (sent in the body only). */
export function viewOwnReport(id: string, secret?: string, signal?: AbortSignal) {
  return call(`/reports/r/${id}/view`, reporterDetailSchema, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secret ? { secret } : {}),
  });
}

export function withdrawReport(id: string, secret?: string) {
  return call(`/reports/r/${id}/withdraw`, submittedSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secret ? { secret } : {}),
  });
}

/** The signed-in account's reports, newest first. */
export function myReports(signal?: AbortSignal) {
  return call('/reports/mine', mineSchema, { signal });
}

/** One re-encoded screenshot for a report this session just filed (upload key = request id). */
export function uploadScreenshot(id: string, requestId: string, image: Blob) {
  return call(`/reports/${id}/files`, z.object({ uploaded: z.literal(true) }), {
    method: 'POST',
    headers: { 'Content-Type': image.type, 'X-Report-Request-Id': requestId },
    body: image,
  });
}
