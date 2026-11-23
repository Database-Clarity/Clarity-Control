import { languages, usesEnglishFallback, type Lang, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { globalAggregates, globalsEnabled } from '../../services/globalsFlag';
import {
  globalDefinitions,
  globalPath,
  globalTypes,
  globalUsageEntries,
  uncomment,
  type GlobalKind,
} from '../globals/model';
import type { PendingTooltip } from './model';
import { publishedFor, usePublished, type Published } from './published';

type ByHash = Parameters<typeof publishedFor>[0];

/**
 * The global exports, variables, and titles are each published as one file but edited as separate
 * entries, so Review lists one row per entry that changed. The file stays the unit that is ticked,
 * counted, and published: every row of a file carries the file's hash.
 */
export interface GlobalPart {
  kind: GlobalKind;
  name: string;
  /** The published file's own pending change: what is ticked and published. */
  unit: PendingTooltip;
  /** Every listed entry of the file, this one included. */
  names: string[];
  /** This entry's published definition (`tooltip` null: not published before). */
  published: Published | undefined;
  /** The declarations as written, for raw markup. */
  source: { before: Definition['source']; after: Definition['source'] };
  /** What is known without rendering: no longer goes live, or the same text in another declaration. */
  change?: 'removed' | 'same-text';
}

/** A row's identity: the tooltip hash, or the file's hash and the entry's name. */
export type RowKey = number | string;
export const rowKey = ({ tooltip, part }: PendingTooltip): RowKey =>
  part ? `${tooltip.hash}:${part.name}` : tooltip.hash;

/** The row a `?hash=` names; a file's plain hash (or an entry no longer listed) finds its first. */
export function routedRow<T extends PendingTooltip>(
  rows: readonly T[],
  routed: string,
): T | undefined {
  return (
    rows.find((row) => String(rowKey(row)) === routed) ??
    rows.find(({ tooltip }) => String(tooltip.hash) === routed.split(':')[0])
  );
}

/** A named entry that is not listed, while the published file could still list it (a removal). */
export function unresolvedRow(
  rows: readonly PendingTooltip[],
  routed: string,
  byHash: ByHash,
): boolean {
  if (!routed.includes(':') || rows.some((row) => String(rowKey(row)) === routed)) return false;
  const file = routedRow(rows, routed);
  const status = file && publishedOf(file, byHash)?.status;
  return !!file && (status === undefined || status === 'loading');
}

/** The file as it goes live: a language that falls back to English holds the English text. */
function exportedFile(file: Tooltip): Tooltip {
  const text: Tooltip['text'] = {};
  for (const lang of languages) {
    const cell = file.text[usesEnglishFallback(file, lang) ? 'en' : lang];
    if (file.text[lang] && cell)
      text[lang] = { text: cell.text, updatedAt: cell.updatedAt, updatedBy: cell.updatedBy };
  }
  return { ...file, text };
}

interface Definition {
  source: Partial<Record<Lang, string>>;
  /** The bodies only, as a tooltip, so the ordinary comparison applies to them. */
  tooltip: Tooltip;
}

function definitionsOf(file: Tooltip): Map<string, Definition> {
  const result = new Map<string, Definition>();
  for (const { kind, name, lines, definitions } of globalDefinitions({ [file.hash]: file })) {
    const definition: Definition = {
      source: {},
      tooltip: { hash: file.hash, text: {}, associated: [] },
    };
    for (const lang of languages) {
      const cell = file.text[lang];
      const line = lines[lang];
      if (!cell || line === undefined) continue;
      const raw = cell.text.replace(/\r/g, '');
      const all = raw.split('\n');
      const end = kind === 'variables' ? line - 1 : uncomment(raw).split('\n').indexOf(')', line);
      definition.source[lang] = all.slice(line - 1, end + 1).join('\n');
      definition.tooltip.text[lang] = {
        ...cell,
        text: kind === 'variables' ? definitions[lang]! : all.slice(line, end).join('\n'),
      };
    }
    result.set(name, definition);
  }
  return result;
}

const none: Definition['source'] = {};
const noText = (hash: number): Tooltip => ({ hash, text: {}, associated: [] });

/** One row per entry that changed; the file itself when no entry accounts for its change. */
function partsOf(unit: PendingTooltip, published: Published | undefined): PendingTooltip[] {
  const hash = unit.tooltip.hash;
  const kind = globalTypes.find((type) => type.hash === hash)!.kind;
  const liveFile =
    published?.status === 'ready' && published.tooltip
      ? exportedFile(published.tooltip)
      : undefined;
  // Bodies are compared as they go live; raw markup shows what is written.
  const saved = definitionsOf(exportedFile(unit.tooltip));
  const savedSource = definitionsOf(unit.tooltip);
  // Which entries changed is only known with the published file; until then every one is listed.
  const live =
    published?.status === 'ready'
      ? liveFile
        ? definitionsOf(liveFile)
        : new Map<string, Definition>()
      : undefined;
  const liveSource =
    published?.status === 'ready' && published.tooltip
      ? definitionsOf(published.tooltip)
      : undefined;
  const names: string[] = [];
  const rows: PendingTooltip[] = [];
  for (const name of [...new Set([...saved.keys(), ...(live?.keys() ?? [])])].sort((a, b) =>
    a.localeCompare(b),
  )) {
    const after = saved.get(name);
    const before = live?.get(name);
    const source = {
      before: liveSource?.get(name)?.source ?? none,
      after: savedSource.get(name)?.source ?? none,
    };
    const sameText =
      !!live &&
      languages.every(
        (lang) => before?.tooltip.text[lang]?.text === after?.tooltip.text[lang]?.text,
      );
    if (sameText && languages.every((lang) => source.before[lang] === source.after[lang])) continue;
    names.push(name);
    rows.push({
      ...unit,
      tooltip: after?.tooltip ?? noText(hash),
      name,
      part: {
        kind,
        name,
        unit,
        names,
        published:
          published?.status === 'ready'
            ? { status: 'ready', tooltip: before?.tooltip ?? null }
            : published,
        source,
        ...(!after
          ? { change: 'removed' as const }
          : sameText
            ? { change: 'same-text' as const }
            : {}),
      },
    });
  }
  return rows.length ? rows : [unit];
}

/**
 * Whether an entry's output depends on anything but its own text (an import, a variable, or a
 * title). What those hold when it goes live is not compared here, so no "unchanged" claim is made.
 */
export const usesOthers = (tooltip: Tooltip) =>
  Object.values(tooltip.text).some((cell) => /^import |#|<title/m.test(cell?.text ?? ''));

const expanded = new WeakMap<
  readonly PendingTooltip[],
  { used: (Published | undefined)[]; rows: PendingTooltip[] }
>();
const isFile = ({ categoryId, markerOnly, tooltip }: PendingTooltip) =>
  categoryId === '~globals' && !markerOnly && globalAggregates.includes(tooltip.hash);
// A row without a marker gets a fresh "nothing published" object on every ask.
const same = (a: Published | undefined, b: Published | undefined) =>
  a === b || (a?.status === 'ready' && b?.status === 'ready' && a.tooltip === b.tooltip);

/** The list Review shows: every pending change, with a globals file as its changed entries. */
export function reviewRows(entries: PendingTooltip[], byHash: ByHash): PendingTooltip[] {
  const files = entries.filter(isFile);
  if (!files.length) return entries;
  // Rows stay the same objects until these files' own published text changes.
  const used = files.map((file) => publishedOf(file, byHash));
  const known = expanded.get(entries);
  if (known?.used.every((value, index) => same(value, used[index]))) return known.rows;
  const rows = entries.flatMap((entry) => {
    const index = files.indexOf(entry);
    return index < 0 ? [entry] : partsOf(entry, used[index]);
  });
  expanded.set(entries, { used, rows });
  return rows;
}

const noEntries: PendingTooltip[] = [];
export function useReviewRows(entries: PendingTooltip[] | null): PendingTooltip[] {
  return reviewRows(
    entries ?? noEntries,
    usePublished((state) => state.byHash),
  );
}

/** The published version a row is compared with. */
export const publishedOf = (entry: PendingTooltip, byHash: ByHash): Published | undefined =>
  entry.part ? entry.part.published : publishedFor(byHash, entry.tooltip.hash, entry.pushed);

/** How many changes (publish units) these rows stand for. */
export const unitCount = (rows: readonly PendingTooltip[]) =>
  new Set(rows.map(({ tooltip }) => tooltip.hash)).size;

const list = new Intl.ListFormat('en');

/** What ticking the row ticks: its own name, or every listed entry of its file. */
export const unitName = ({ name, part }: PendingTooltip) => (part ? list.format(part.names) : name);

export const unitNames = (entries: PendingTooltip[], byHash: ByHash) =>
  new Map(reviewRows(entries, byHash).map((row) => [row.tooltip.hash, unitName(row)]));

const hasPage = (part: GlobalPart) => Object.keys(part.source.after).length > 0;
/** Where a row is edited (`/t/1?global=name` opens the entry itself); a removed entry has no page. */
export const editorPath = ({ tooltip, part }: PendingTooltip) =>
  !part
    ? `/t/${tooltip.hash}`
    : hasPage(part)
      ? globalPath({ hash: tooltip.hash, name: part.name })
      : globalsEnabled
        ? '/globals'
        : `/t/${tooltip.hash}`;
export const editorLabel = ({ part }: PendingTooltip) =>
  part && !hasPage(part) ? 'Open globals' : 'Open in editor';

/** How many tooltips use this entry directly, as saved. */
export function globalUsers({ kind, name }: GlobalPart, data: EditorData): number {
  // Only texts that contain the name can use it; the full index reads every text.
  const near = Object.fromEntries(
    Object.entries(data.bundle.tooltips).filter(
      ([hash, { text }]) =>
        globalAggregates.includes(Number(hash)) ||
        Object.values(text).some((cell) => cell?.text.includes(name)),
    ),
  );
  const entry = globalUsageEntries(near).find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  return new Set(
    entry?.usages.map(({ hash }) => hash).filter((hash) => !globalAggregates.includes(hash)),
  ).size;
}
