// The data site's build files (export spec section 3): `/_build/status.json` names the snapshot the
// preview loads, `/_build/manifest.json` lists every published file, `/_build/notices.json` the
// build's notices, and `/<project>/index.json` one project's files. All are read-only here.
import { z } from 'zod';

/**
 * Origin of the data site. Nothing is announced yet (go-live is P5); the origin lives here only, so
 * a local fixture site (`VITE_DATA_SITE_URL`) can stand in for it in tests and QA.
 */
export const dataSiteUrl =
  import.meta.env.VITE_DATA_SITE_URL?.trim().replace(/\/+$/, '') || 'https://data.d2clarity.com';

/** The `live` branch the seven legacy files are deployed to; a pin names its exact commit. */
export const liveRawUrl = (import.meta.env.VITE_LIVE_RAW_URL?.trim().replace(/\/+$/, '') ||
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database') as string;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const snapshotNames = [
  'engine.mjs',
  'input.json',
  'identical.json',
  'catalog.json',
] as const;

export const statusSchema = z.object({
  buildId: z.string().regex(/^[0-9a-f]{8,64}$/),
  builtAt: z.string(),
  files: z.object({
    'engine.mjs': sha,
    'input.json': sha,
    'identical.json': sha,
    'catalog.json': sha,
  }),
  engine: z.string(),
  converterSha: z.string(),
  generatorSha: z.string().optional(),
  manifestVersion: z.string().optional(),
  pinId: z.string(),
  liveCommit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Per legacy file name (exact case): the deployed bytes the pin names. */
  legacy: z.record(
    z.string(),
    z.object({ sha256: sha, outcome: z.enum(['built', 'carried', 'frozen']) }),
  ),
});
export type BuildStatus = z.infer<typeof statusSchema>;

const manifestFile = z.object({
  sha256: sha,
  bytes: z.number(),
  lastUpdate: z.string(),
  lastBuilt: z.string().optional(),
  outcome: z.enum(['built', 'carried', 'frozen']),
});
export type ManifestFile = z.infer<typeof manifestFile>;
export const manifestSchema = z.object({
  buildId: z.string(),
  builtAt: z.string(),
  files: z.record(z.string(), manifestFile),
});
export type SiteManifest = z.infer<typeof manifestSchema>;

export const noticeSchema = z.object({
  project: z.string().optional(),
  file: z.string().optional(),
  path: z.string().optional(),
  kind: z.string(),
  message: z.string(),
});
export type SiteNotice = z.infer<typeof noticeSchema>;

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${dataSiteUrl}/${path}`, { cache: 'no-cache', signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return schema.parse(await response.json());
}

export const loadStatus = (signal?: AbortSignal) =>
  getJson('_build/status.json', statusSchema, signal);
export const loadManifest = (signal?: AbortSignal) =>
  getJson('_build/manifest.json', manifestSchema, signal);
/** Notices of the last build; a site without the file (an older build) has none. */
export const loadNotices = (signal?: AbortSignal) =>
  getJson('_build/notices.json', z.array(noticeSchema), signal).catch(() => [] as SiteNotice[]);

/** The URL partners download a file from. */
export const fileUrl = (path: string) => `${dataSiteUrl}/${path}`;

/** Build state of one URL, for the list's dot and the project header. */
export type BuildState =
  | { kind: 'live'; file: ManifestFile }
  | { kind: 'carried' | 'frozen'; file: ManifestFile }
  | { kind: 'absent' };

export function buildState(manifest: SiteManifest | null, path: string): BuildState {
  const file = manifest?.files[path];
  if (!file) return { kind: 'absent' };
  return file.outcome === 'built' ? { kind: 'live', file } : { kind: file.outcome, file };
}

/**
 * build-site notice kinds (P2 SiteNotice) that mean a file did not update: a failed or invalid
 * build, a file left out or carried forward, or a frozen URL. The others are informational.
 */
const failureKinds = new Set([
  'invalid-config',
  'over-limit',
  'build-failed',
  'carried-forward',
  'not-published',
  'frozen',
  'budget',
]);
export const isFailure = (notice: SiteNotice) => failureKinds.has(notice.kind);

/** A notice's text for people: compile notices carry their detail as JSON. */
export function noticeText(notice: SiteNotice): string {
  if (notice.kind !== 'compile') return notice.message;
  try {
    const detail = JSON.parse(notice.message) as Record<string, unknown>;
    switch (detail.kind) {
      case 'unchosen-symbol':
        return `Symbols not chosen (dropped, text kept): ${String(detail.symbols)}`;
      case 'retired-markup':
        return `Retired markup in the data (left out): ${String(detail.classNames)}`;
      case 'tables-dropped':
        return `${String(detail.count)} tables left out (styles have no tables)`;
      case 'uncategorised':
        return `${(detail.hashes as unknown[]).length} tooltips have no item category and are left out`;
      case 'unknown-category':
        return `Categories the pinned catalog lacks: ${String(detail.categories)}`;
    }
  } catch {
    // Not JSON: show it as written.
  }
  return notice.message;
}
