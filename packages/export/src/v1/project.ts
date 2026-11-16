// Per-project paths and `/<project>/index.json` (spec sections 3 and 7): the small file apps
// poll; they download a URL only when its sha256 changes. build-site fills in the numbers.
import type { ExportConfig } from './config.js';
import type { Notice } from './compile.js';
import { fileUrls, type ExportLanguage } from './vocabulary.js';

/** The site's own record of a URL (build-site manifest): built now, carried, or frozen. */
export type FileOutcome = 'built' | 'carried' | 'frozen';
/**
 * What index.json says about a URL: `current` (built from the current data), `stale` (the last
 * build failed, so the previous bytes stay), or `frozen` (a retained URL that stopped updating).
 */
export type FileStatus = 'current' | 'stale' | 'frozen';
export const fileStatus: Record<FileOutcome, FileStatus> = {
  built: 'current',
  carried: 'stale',
  frozen: 'frozen',
};

/** One URL of index.json: a whole file, or one language of a file split per language. */
export type IndexFile = {
  id: string;
  format: number;
  path: string;
  languages: ExportLanguage[];
  sha256: string;
  bytes: number;
  /** ISO date-time of the last change to the URL's bytes. */
  updatedAt: string;
  status: FileStatus;
  /** Present on a retained old URL: it keeps updating until this ISO date-time. */
  updatesUntil?: string;
};

/** The numbers build-site records for one URL. */
export type BuiltUrl = { sha256: string; bytes: number; lastUpdate: string; outcome: FileOutcome };

/** A notice about one file: the compiler's own (`Notice`) or build-site's (carried, frozen, ...). */
export type FileNotice = (Notice | { kind: string; message: string }) & { file: string };

export type ProjectIndex = {
  project: string;
  name: string;
  files: IndexFile[];
  notices: FileNotice[];
};

/**
 * Builds a project's index.json value: one entry per URL. `built` holds each published URL's
 * numbers (active files and retained entries, keyed by path); a URL without numbers (a new file
 * whose first build failed) is left out. Order: active files as configured, then retained
 * entries; a file split per language lists its languages in the engine's language order.
 */
export function projectIndex(
  config: ExportConfig,
  built: Readonly<Record<string, BuiltUrl>>,
  notices: readonly FileNotice[] = [],
): ProjectIndex {
  const files: IndexFile[] = [];
  const add = (file: ExportConfig['files'][number], until?: string) => {
    for (const { path, languages } of fileUrls(config.id, file)) {
      const url = built[path];
      if (!url) continue;
      files.push({
        id: file.id,
        format: file.formatVersion,
        path,
        languages,
        sha256: url.sha256,
        bytes: url.bytes,
        updatedAt: url.lastUpdate,
        status: fileStatus[url.outcome],
        ...(until ? { updatesUntil: until } : {}),
      });
    }
  };
  for (const file of config.files) add(file);
  for (const entry of config.retained ?? [])
    add({ ...entry.snapshot, formatVersion: entry.formatVersion }, entry.until);
  return { project: config.id, name: config.name, files, notices: [...notices] };
}
