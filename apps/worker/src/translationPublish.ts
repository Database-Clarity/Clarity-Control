import {
  globalRecordSchema,
  globalsInPlaceCapability,
  globalsInPlaceFenceSchema,
  globalsInPlacePath,
  globalsReleasePaths,
  tooltipSchema,
  translationBeforeDigest,
  translationEnglishDigest,
  translationEnglishGate,
  translationExpectedDigest,
  translationFallbackIds,
  translationPublishCapability,
  translationPublishContract,
  translationPublishReasons,
  type GlobalRecord,
  type LangText,
  type GlobalDefinition,
  type TranslationPublishReason,
  type TranslationPublishRow,
} from '@clarity/core';
import { publisherPinPath } from './elementTags.js';
import type { RepoFile, TreeNode } from './github.js';
import { HttpError } from './http.js';
import type { Access } from './permissions.js';
import type { Env } from './types.js';

export const translationPartRows = 12;
const rootsPath = 'live/translation-roots.json';
export const translationReadinessPaths = [publisherPinPath, globalsInPlacePath, rootsPath];
const oid = /^[a-f0-9]{40}$/;

export function wantsTranslationContract(url: URL): boolean {
  const contracts = url.searchParams.getAll('contract');
  return contracts.length === 1 && contracts[0] === translationPublishContract;
}

export function translationPublishEnabled(env: Env): boolean {
  return env.TRANSLATION_PUBLISH === '1' && !!env.PUBLISH_SIGNING_KEY;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The publisher writes this index in the same RECORD as the published snapshots. An old
// snapshot and marker can survive a LIVE root becoming an alias, so neither proves activity.
export function translationRoots(
  [pin, fence, index]: readonly (RepoFile | null)[],
  destination: string,
) {
  const capabilities = object(pin?.value)?.capabilities;
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(globalsInPlaceCapability) ||
    !capabilities.includes(translationPublishCapability)
  )
    return undefined;
  const parsed = globalsInPlaceFenceSchema.safeParse(fence?.value);
  if (!parsed.success || parsed.data.state !== 'active' || parsed.data.destination !== destination)
    return undefined;
  const record = object(index?.value);
  if (
    record?.destination !== destination ||
    typeof record.liveCommit !== 'string' ||
    !oid.test(record.liveCommit)
  )
    return undefined;
  return object(record.roots);
}

export function requireTranslationLanguages(
  access: Access,
  rows: readonly TranslationPublishRow[],
) {
  if (access.role === 'translator' && rows.some(({ lang }) => !access.languages?.includes(lang)))
    throw new HttpError(403, 'Publish only translations in your assigned languages');
}

export function rowIdentity(row: TranslationPublishRow) {
  const { lang } = row;
  return row.kind === 'tooltip'
    ? { kind: row.kind, hash: row.hash, lang }
    : { kind: row.kind, id: row.id, lang };
}

function refuseRow(row: TranslationPublishRow, reason: TranslationPublishReason): never {
  throw new HttpError(409, translationPublishReasons[reason], {
    rows: [{ ...rowIdentity(row), reason }],
  });
}

const tooltipPaths = (hash: number) =>
  [`tooltips/${hash}.json`, `live/tooltips/${hash}.json`] as const;

export function translationRowPaths(rows: readonly TranslationPublishRow[], destination: string) {
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'tooltip') tooltipPaths(row.hash).forEach((path) => paths.add(path));
    else {
      paths.add(globalsReleasePaths.published(destination));
      paths.add(globalsReleasePaths.entry(row.id));
    }
  }
  return [...paths];
}

type Entry = LangText | GlobalDefinition;

async function checkDigests(
  row: TranslationPublishRow,
  saved: Entry | undefined,
  english: Entry,
  live: Entry | undefined,
  fallback?: readonly number[],
) {
  const [expected, source, before] = await Promise.all([
    translationExpectedDigest(saved),
    translationEnglishDigest(english),
    translationBeforeDigest(live, fallback),
  ]);
  if (expected !== row.expected || source !== row.english) refuseRow(row, 'review-changed');
  // A second publish may see the selected entry already LIVE. The publisher checks
  // the effective output, including fallback membership, before declaring it unchanged.
  if (before !== row.before && (await translationExpectedDigest(live)) !== expected)
    refuseRow(row, 'review-changed');
}

export async function verifyTranslationRows(
  rows: readonly TranslationPublishRow[],
  destination: string,
  files: ReadonlyMap<string, RepoFile | null>,
  roots: Readonly<Record<string, unknown>>,
  conflicts: readonly TreeNode[] | null | undefined,
) {
  const blocked = new Set(conflicts?.map(({ name }) => name));
  const catalogue = object(files.get(globalsReleasePaths.published(destination))?.value);
  const store = object(catalogue?.store);
  const entries = store?.entries;
  const published = new Map<string, unknown>();
  if (
    catalogue?.version === 1 &&
    catalogue.destination === destination &&
    store?.version === 1 &&
    Array.isArray(entries)
  ) {
    const ids = new Set(rows.flatMap((row) => (row.kind === 'global' ? [row.id] : [])));
    for (const entry of entries) {
      const id = object(entry)?.id;
      if (typeof id !== 'string' || !ids.has(id)) continue;
      if (published.has(id)) throw new HttpError(502, 'Duplicate published shared text');
      published.set(id, entry);
    }
  }
  // Check cheap digests and the shared English gate only. The publisher reconstructs
  // effects, affected rows, and fallback changes with the LIVE resolver at the commit fence.
  await Promise.all(
    rows.map(async (row) => {
      if (row.kind === 'tooltip') {
        const [savedPath, livePath] = tooltipPaths(row.hash);
        const savedFile = files.get(savedPath);
        const liveFile = files.get(livePath);
        const root = roots[row.hash];
        const saved = savedFile ? tooltipSchema.parse(savedFile.value) : undefined;
        const live =
          liveFile && root === liveFile.sha ? tooltipSchema.parse(liveFile.value) : undefined;
        const gate = translationEnglishGate({
          kind: 'tooltip',
          hash: row.hash,
          saved,
          live: live
            ? { status: 'active', entry: live }
            : { status: liveFile || root ? 'unverified' : 'missing' },
          // Positive membership in the RECORD index already excludes all LIVE alias roots.
          liveAliases: {},
        });
        if (gate.status !== 'ready') refuseRow(row, gate.reason);
        if (blocked.has(`${row.hash}.json`))
          throw new HttpError(409, 'Resolve this tooltip’s batch activation before publishing.', {
            rows: [{ ...rowIdentity(row), reason: 'review-changed' }],
          });
        const english = live!.text.en!;
        return checkDigests(
          row,
          saved!.text[row.lang],
          english,
          live!.text[row.lang],
          translationFallbackIds(english, row.lang),
        );
      }
      const savedFile = files.get(globalsReleasePaths.entry(row.id));
      const saved = savedFile ? globalRecordSchema.parse(savedFile.value) : undefined;
      const live: GlobalRecord | undefined = published.has(row.id)
        ? globalRecordSchema.parse(published.get(row.id))
        : undefined;
      const gate = translationEnglishGate({
        kind: 'global',
        id: row.id,
        saved,
        live: live ? { status: 'active', entry: live } : { status: 'missing' },
      });
      if (gate.status !== 'ready') refuseRow(row, gate.reason);
      return checkDigests(
        row,
        saved!.definitions[row.lang],
        live!.definitions.en!,
        live!.definitions[row.lang],
      );
    }),
  );
}
