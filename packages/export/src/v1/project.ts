// Per-project paths and `/<project>/index.json` (spec sections 3 and 7): the small file apps
// poll; they download a file only when its sha256 changes. build-site fills in the numbers.
import type { ExportConfig, ExportFile } from './config.js';
import type { Notice } from './compile.js';

/** `<project>/v<format>/<file>.json`, relative to the site root. */
export const filePath = (projectId: string, file: Pick<ExportFile, 'id' | 'formatVersion'>) =>
  `${projectId}/v${file.formatVersion}/${file.id}.json`;

export type FileOutcome = 'built' | 'carried' | 'frozen';

export type IndexFile = {
  id: string;
  formatVersion: number;
  path: string;
  sha256: string;
  bytes: number;
  /** ISO date-time of the last change to the file's bytes. */
  lastUpdate: string;
  outcome: FileOutcome;
  /** Present on a retained old URL: it keeps updating until this ISO date-time. */
  until?: string;
};

/** A notice about one file: the compiler's own (`Notice`) or build-site's (carried, frozen, ...). */
export type FileNotice = (Notice | { kind: string; message: string }) & { file: string };

export type ProjectIndex = {
  project: string;
  name: string;
  files: IndexFile[];
  notices: FileNotice[];
};

/**
 * Builds a project's index.json value. `built` holds each published URL's numbers (active files
 * and retained entries, keyed by path); a path without numbers (a new file whose first build
 * failed) is left out. Order: active files as configured, then retained entries.
 */
export function projectIndex(
  config: ExportConfig,
  built: Readonly<Record<string, Omit<IndexFile, 'id' | 'formatVersion' | 'path' | 'until'>>>,
  notices: readonly FileNotice[] = [],
): ProjectIndex {
  const files: IndexFile[] = [];
  for (const file of config.files) {
    const path = filePath(config.id, file);
    if (built[path])
      files.push({ id: file.id, formatVersion: file.formatVersion, path, ...built[path] });
  }
  for (const entry of config.retained ?? []) {
    if (built[entry.path])
      files.push({
        id: entry.snapshot.id,
        formatVersion: entry.formatVersion,
        path: entry.path,
        ...built[entry.path],
        until: entry.until,
      });
  }
  return { project: config.id, name: config.name, files, notices: [...notices] };
}
