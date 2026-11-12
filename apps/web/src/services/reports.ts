import { langSchema } from '../../../../packages/core/src/languages';
import {
  reportCategorySchema,
  reportIdSchema,
  reportStatusSchema,
  type ReportSubmission,
} from '../../../../packages/core/src/reports/schemas';
import { z } from 'zod';
import { apiRequest, apiUrl } from './api';

/**
 * The typed client for the public issue-report routes (apps/worker/src/reports.ts): the catalog the
 * picker searches, the public anchors, submit, receipt, view, withdraw, My reports, and screenshot
 * upload. Role routes (index, pane bodies, list, actions) live with the editor's Reports pane.
 * Every call returns parsed data or throws a ReportApiError carrying the server's status, message,
 * and wait time, so the page can show what the server said.
 */

const dataRepo = 'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database';
export const reportCatalogUrl = `${dataRepo}/editor-data-bundle/report-items.json`;

/** A tooltip file as the public page needs it: text per language, nothing else. */
const tooltipFileSchema = z.object({
  text: z.record(z.string(), z.object({ text: z.string() }).passthrough()),
});
export type ReportTooltipFile = z.infer<typeof tooltipFileSchema>;

export type { ReportCatalog, ReportCatalogItem } from './reportCatalog';
import { reportCatalogSchema, type ReportCatalog } from './reportCatalog';

const publicAnchorSchema = z.object({
  n: z.number().int(),
  category: z.string(),
  status: z.string(),
  age: z.number(),
  variant: z.string(),
  rev: z.string().nullable(),
  start: z.number().int().nullable(),
  end: z.number().int().nullable(),
});
export type PublicAnchor = z.infer<typeof publicAnchorSchema>;

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

const errorBodySchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
const limitDetailsSchema = z.object({ key: z.string(), retry_after: z.number() });

/** A refused or failed report call. `status` 0 = the request never reached the server. */
export class ReportApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Seconds until the limit named by `limitKey` resets (429, and 503 for the global ceiling). */
    public retryAfter?: number,
    public limitKey?: string,
  ) {
    super(message);
    this.name = 'ReportApiError';
  }
}

async function refusal(response: Response): Promise<ReportApiError> {
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  if (!body.success)
    return new ReportApiError(response.status, `The server answered HTTP ${response.status}.`);
  const limit = limitDetailsSchema.safeParse(body.data.details);
  return new ReportApiError(
    response.status,
    body.data.error,
    limit.success ? limit.data.retry_after : undefined,
    limit.success ? limit.data.key : undefined,
  );
}

async function call<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  if (!apiUrl) throw new ReportApiError(0, 'Reports are unavailable: no API is configured.');
  const { auth = true, ...rest } = init;
  let response: Response;
  try {
    response = auth
      ? await apiRequest(path, rest)
      : await fetch(`${apiUrl}${path}`, { ...rest, credentials: 'omit' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ReportApiError(0, 'Could not reach the report service.');
  }
  if (!response.ok) throw await refusal(response);
  return schema.parse(await response.json());
}

/** The picker's catalog: every hash a consumer may show, with its editable owner and variant. */
export async function loadReportCatalog(signal?: AbortSignal): Promise<ReportCatalog> {
  const response = await fetch(reportCatalogUrl, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`Report catalog: HTTP ${response.status}`);
  return reportCatalogSchema.parse(await response.json());
}

/**
 * One tooltip file at the catalog's data commit, so the text, its imports, and the stored
 * `data_commit` all describe the same revision. `undefined` = no such file.
 */
export async function loadReportTooltip(
  commit: string,
  hash: number,
  signal?: AbortSignal,
): Promise<ReportTooltipFile | undefined> {
  const response = await fetch(`${dataRepo}/${commit}/tooltips/${hash}.json`, { signal });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Tooltip ${hash}: HTTP ${response.status}`);
  return tooltipFileSchema.parse(await response.json());
}

/** Open anchors on a tooltip, offsets only (no quotes, notes, or identities). */
export function publicAnchors(
  owner: number,
  lang: string,
  signal?: AbortSignal,
): Promise<PublicAnchor[]> {
  const query = new URLSearchParams({ hash: String(owner), lang });
  return call(`/reports/public?${query}`, z.array(publicAnchorSchema), { signal, auth: false });
}

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

/** A readable wait: "4 min", "1 h 5 min", "30 s". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
