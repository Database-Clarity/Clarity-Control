// Client for the Worker's /exports routes (export spec section 4; P3 reports/export-p3.md).
// Every response is parsed; a stored config is validated again with the shared strict schema
// (`migrateConfig`), so the page never edits a config the Worker would refuse to read.
import { migrateConfig, type ExportConfig } from '@clarity/export/config';
import { z } from 'zod';
import { apiRequest } from '../../services/api';

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const partner = z.object({ id: z.number(), login: z.string() });

const rowSchema = z.object({
  id: z.string(),
  revision,
  schema: z.number().optional(),
  name: z.string().optional(),
  files: z
    .array(z.object({ id: z.string(), preset: z.string(), formatVersion: z.number() }))
    .optional(),
  retained: z.number().optional(),
  /** Set when the stored config cannot be read (listed so a maintainer sees it). */
  error: z.string().optional(),
  partners: z.array(partner).optional(),
});
export type ProjectRow = z.infer<typeof rowSchema>;
export type Partner = z.infer<typeof partner>;

const listSchema = z.object({
  head: z.string(),
  partnersRevision: revision.optional(),
  projects: z.array(rowSchema),
});
export type ProjectList = z.infer<typeof listSchema>;

const projectSchema = z.object({
  head: z.string(),
  id: z.string(),
  revision,
  config: z.unknown(),
  partnersRevision: revision.optional(),
  partners: z.array(partner).optional(),
});
export interface LoadedProject {
  id: string;
  revision: string;
  config: ExportConfig;
  partnersRevision?: string;
  partners?: Partner[];
}

const errorSchema = z.object({ error: z.string(), details: z.unknown().optional() });

/** A refused request, with the Worker's own message (shown to people as is). */
export class ExportsError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await apiRequest(path, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    throw new ExportsError(
      response.status,
      parsed.success ? parsed.data.error : `The server answered HTTP ${response.status}`,
      parsed.success ? parsed.data.details : undefined,
    );
  }
  return body;
}

export async function listProjects(): Promise<ProjectList> {
  return listSchema.parse(await call('/exports/projects'));
}

export async function loadProject(id: string): Promise<LoadedProject> {
  const data = projectSchema.parse(
    await call(`/exports/projects?project=${encodeURIComponent(id)}`),
  );
  return {
    id: data.id,
    revision: data.revision,
    config: migrateConfig(data.config),
    partnersRevision: data.partnersRevision,
    partners: data.partners,
  };
}

const savedSchema = z.object({
  commit: z.string().nullable(),
  revision,
  config: z.unknown(),
});

export type SaveOutcome =
  | { kind: 'saved'; revision: string; config: ExportConfig; commit: string | null }
  /** The project changed since it was loaded (409): reload, keep the edits. */
  | { kind: 'conflict'; message: string }
  /** Saved moments ago (429): the Worker names the wait in seconds. */
  | { kind: 'cooldown'; message: string; retryAfter: number }
  | { kind: 'refused'; message: string; details?: unknown };

function outcome(error: unknown): SaveOutcome {
  if (!(error instanceof ExportsError)) throw error;
  if (error.status === 409) return { kind: 'conflict', message: error.message };
  if (error.status === 429) {
    const wait = z.object({ retryAfter: z.number() }).safeParse(error.details);
    return {
      kind: 'cooldown',
      message: error.message,
      retryAfter: wait.success ? Math.max(1, Math.ceil(wait.data.retryAfter)) : 30,
    };
  }
  return { kind: 'refused', message: error.message, details: error.details };
}

export async function saveProject(
  id: string,
  revisionId: string,
  config: ExportConfig,
): Promise<SaveOutcome> {
  try {
    const data = savedSchema.parse(
      await call(`/exports/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ revision: revisionId, config }),
      }),
    );
    return {
      kind: 'saved',
      revision: data.revision,
      config: migrateConfig(data.config),
      commit: data.commit,
    };
  } catch (error) {
    return outcome(error);
  }
}

export async function createProject(config: ExportConfig): Promise<SaveOutcome> {
  try {
    const data = savedSchema.parse(
      await call('/exports/projects', { method: 'POST', body: JSON.stringify({ config }) }),
    );
    return {
      kind: 'saved',
      revision: data.revision,
      config: migrateConfig(data.config),
      commit: data.commit,
    };
  } catch (error) {
    return outcome(error);
  }
}

export async function setPartners(
  id: string,
  partnersRevision: string,
  logins: string[],
): Promise<{ partnersRevision: string; partners: Partner[] }> {
  return z.object({ partnersRevision: revision, partners: z.array(partner) }).parse(
    await call(`/exports/projects/${encodeURIComponent(id)}/partners`, {
      method: 'PUT',
      body: JSON.stringify({ revision: partnersRevision, logins }),
    }),
  );
}

export async function deleteProject(id: string, revisionId: string): Promise<string[]> {
  return z.object({ removed: z.array(z.string()) }).parse(
    await call(`/exports/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ revision: revisionId }),
    }),
  ).removed;
}
