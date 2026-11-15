import * as z from 'zod/mini';
import { apiRequest, apiUrl } from './apiAuth';

/**
 * The typed client for the public issue-report reads a direct link makes on load
 * (apps/worker/src/reports.ts): the catalog the picker searches, tooltip files, and the public
 * anchors, plus the shared call and error handling. The reporter's own routes (submit, receipt,
 * view, withdraw, My reports, and screenshot upload) are in reportAccount.ts, loaded when used;
 * role routes (index, pane bodies, list, actions) live with the editor's Reports pane. Every call
 * returns parsed data or throws a ReportApiError carrying the server's status, message, and wait
 * time, so the page can show what the server said. zod/mini keeps the public cold load small.
 */

const dataRepo = 'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database';
export const reportCatalogUrl = `${dataRepo}/editor-data-bundle/report-items.json`;

/** A tooltip file as the public page needs it: text per language, nothing else. */
const tooltipFileSchema = z.object({
  text: z.record(z.string(), z.looseObject({ text: z.string() })),
});
export type ReportTooltipFile = z.infer<typeof tooltipFileSchema>;

export type { ReportCatalog, ReportCatalogItem } from './reportCatalog';
import { reportCatalogSchema, type ReportCatalog } from './reportCatalog';
export type { MyReport, ReportPayload, ReportReceipt, ReporterDetail } from './reportAccount';

const publicAnchorSchema = z.object({
  n: z.int(),
  category: z.string(),
  status: z.string(),
  age: z.number(),
  variant: z.string(),
  rev: z.nullable(z.string()),
  start: z.nullable(z.int()),
  end: z.nullable(z.int()),
});
export type PublicAnchor = z.infer<typeof publicAnchorSchema>;

const errorBodySchema = z.object({
  error: z.string(),
  details: z.optional(z.unknown()),
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

/**
 * One Worker call, parsed by the schema's own `parse` (zod/mini here, the shared classic schemas
 * in reportAccount.ts), so errors carry that zod's messages.
 */
export async function call<T>(
  path: string,
  schema: { parse(data: unknown): T },
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

/** A readable wait: "4 min", "1 h 5 min", "30 s". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
