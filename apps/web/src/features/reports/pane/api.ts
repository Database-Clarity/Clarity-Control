import { reportStatusSchema } from '@clarity/core';
import { z } from 'zod';
import { apiRequest } from '../../../services/api';

/** The editor pane's own read module (the public page has its own in services/reports.ts). */

const nullableText = z.string().nullable().optional();
export const paneNoteSchema = z.object({
  n: z.number(),
  category: z.string(),
  text: z.string(),
  exact: nullableText,
  prefix: nullableText,
  suffix: nullableText,
  start: z.number().nullable().optional(),
  end: z.number().nullable().optional(),
  line: z.number().nullable().optional(),
  whole: z.number().nullable().optional(),
  rev: nullableText,
});
export type PaneNote = z.infer<typeof paneNoteSchema>;

const linksSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}, z.array(z.string()).catch([]));

export const paneReportSchema = z.object({
  id: z.string(),
  owner_hash: z.number(),
  viewed_hash: z.number(),
  variant: z.string(),
  lang: z.string(),
  seen_lang: nullableText,
  rev: z.string(),
  data_commit: z.string(),
  status: reportStatusSchema,
  version: z.number(),
  category: z.string(),
  note: z.string(),
  source_url: nullableText,
  src: nullableText,
  reporter_id: z.number().nullable().optional(),
  reporter_login: nullableText,
  trust: z.enum(['anonymous', 'account', 'role']),
  created_at: z.number(),
  updated_at: z.number(),
  claimed_by: nullableText,
  links: linksSchema,
  files_count: z.number().default(0),
  duplicate_of: nullableText,
  same_count: z.number().default(0),
  closed_note: nullableText,
  notes: z.array(paneNoteSchema),
  reporter_history: z
    .object({ filed: z.number(), accepted: z.number(), rejected: z.number() })
    .nullable()
    .optional(),
});
export type PaneReport = z.infer<typeof paneReportSchema>;

export class ReportsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<never> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // Keep the status line.
  }
  throw new ReportsHttpError(response.status, message);
}

export const indexSchema = z.object({
  v: z.literal(1),
  rev: z.string(),
  open: z.record(z.string(), z.record(z.string(), z.number())),
});
export type ReportsIndex = z.infer<typeof indexSchema>;

/**
 * The roles-only marker index. `etag` revalidates: a 304 answers `unchanged` and costs the Worker
 * one meta row. `no-store` keeps the browser cache out of it, so a 304 reaches this code.
 */
export async function fetchReportsIndex(
  etag: string | undefined,
): Promise<
  { unchanged: true } | { unchanged: false; etag: string | undefined; index: ReportsIndex }
> {
  const response = await apiRequest('/reports/index', {
    method: 'GET',
    cache: 'no-store',
    headers: etag ? { 'If-None-Match': etag } : undefined,
  });
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) return failure(response);
  return {
    unchanged: false,
    etag: response.headers.get('ETag') ?? undefined,
    index: indexSchema.parse(await response.json()),
  };
}

export async function fetchTooltipReports(hash: number, lang: string): Promise<PaneReport[]> {
  const query = new URLSearchParams({ hash: String(hash), lang });
  const response = await apiRequest(`/reports?${query}`);
  if (!response.ok) return failure(response);
  return z.array(paneReportSchema).parse(await response.json());
}

export type PaneAction =
  | { action: 'triage' | 'claim' | 'reopen' | 'close' | 'spam' }
  | { action: 'reject'; reason: RejectReason }
  | { action: 'duplicate'; of: string };
export type RejectReason = 'not-an-issue' | 'works-as-described' | 'out-of-scope' | 'unclear';

/** One report, one expected version: the Worker answers 409 when someone changed it first. */
export async function postReportAction(
  id: string,
  expectedVersion: number,
  action: PaneAction,
): Promise<{ id: string; status: z.infer<typeof reportStatusSchema>; version: number }> {
  const response = await apiRequest(`/reports/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_version: expectedVersion, ...action }),
  });
  if (!response.ok) return failure(response);
  return z
    .object({ id: z.string(), status: reportStatusSchema, version: z.number() })
    .parse(await response.json());
}

export async function deleteReport(id: string): Promise<void> {
  const response = await apiRequest(`/reports/${id}`, { method: 'DELETE' });
  if (!response.ok) return failure(response);
}

/** A screenshot as an object URL (an `<img src>` cannot carry the bearer token). 404 = gone. */
export async function fetchScreenshot(id: string, n: number): Promise<string | null> {
  const response = await apiRequest(`/reports/${id}/files/${n}`);
  if (response.status === 404) return null;
  if (!response.ok) return failure(response);
  return URL.createObjectURL(await response.blob());
}
