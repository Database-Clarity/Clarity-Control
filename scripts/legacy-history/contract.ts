/** Frozen published history, schema version 1. Hashes are uint32; commits are 40 lowercase hex. */
export type Language =
  | 'en'
  | 'de'
  | 'es'
  | 'es-mx'
  | 'fr'
  | 'it'
  | 'ja'
  | 'ko'
  | 'pl'
  | 'pt-br'
  | 'ru'
  | 'zh-chs'
  | 'zh-cht';
export interface PublishedRevision {
  commit: string;
  author: string;
  /** ISO 8601 author date, including its original UTC offset. */
  date: string;
  /** Full GitHub source commit message. */
  message: string;
  /** null = recorded deletion; missing language != an explicitly empty string. */
  text: Partial<Record<Language, string>> | null;
}
export interface PublishedLane {
  hash: number;
  sourceHash: number;
  /** True only for an exact canonical source identity. Never infer identity from names. */
  verified: boolean;
  /** Oldest to newest, in source history order, not sorted by author date. */
  revisions: PublishedRevision[];
}
export interface PublishedHistory {
  schemaVersion: 1;
  hash: number;
  cutoff: string;
  mappingCommit: string;
  lanes: PublishedLane[];
}
/** HTTP 404 means no artifact. It is not a recorded tooltip deletion. */
export type PublishedHistoryResult = PublishedHistory | null;
export interface PublishedHistoryManifest {
  schemaVersion: 1;
  cutoff: string;
  mappingCommit: string;
  dataCommit: string;
  paths: string[];
  /** Missing/empty whole-file source snapshots are gaps, never fabricated deletions. */
  gaps: string[];
  files: Record<string, { sha256: string; bytes: number; gzipBytes: number; revisions: number }>;
}
export const publishedHistoryCommit = 'c86485f767b70225e44dbe0262cd61e332522e4e';
export const publishedHistoryBaseUrl = `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${publishedHistoryCommit}`;
export const publishedHistoryUrl = (canonicalHash: number) =>
  `${publishedHistoryBaseUrl}/${canonicalHash}.json`;
export const publishedHistoryManifestUrl = `${publishedHistoryBaseUrl}/manifest.json`;
