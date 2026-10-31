import { parseCsv } from '../../../apps/worker/src/csv.js';
import type {
  CompendiumColumns,
  CompendiumTabConfig,
} from '../../../packages/core/src/compendium/config.js';

export interface PlainRow {
  name: string;
  text: string;
  csvRow: number;
}
export interface ParsedRow {
  name: string;
  cell: { plain: string };
  rowIndex: number;
}
export interface Mismatch {
  kind: 'missing' | 'unexpected' | 'text';
  name: string;
  csvRow?: number;
  parsedRow?: number;
  expected?: string;
  actual?: string;
}
export const whitespace = (text: string): string => text.replace(/\s+/gu, ' ').trim();
export const isIncludedTab = (name: string): boolean => !name.includes('OLD');

export function discoverTabs(landing: string): { gid: string; name: string }[] {
  const tabs = new Map<string, { gid: string; name: string }>();
  const records = landing.matchAll(
    /items\.push\(\{name:\s*("(?:\\.|[^"\\])*")[\s\S]*?\bgid:\s*"(-?\d+)"/g,
  );
  for (const [, quotedName, gid] of records) {
    const name: unknown = JSON.parse(quotedName);
    if (typeof name !== 'string' || !name.trim()) throw new Error('Malformed Landing tab name');
    tabs.set(gid, { gid, name });
  }
  if (!tabs.size) throw new Error('Landing did not advertise any tabs');
  return [...tabs.values()];
}

// This module consumes only CSV values and layout configuration. No HTML/grid/parser
// output participates in deciding which rows or text are expected.
export function expectedCsvRows(
  csv: string,
  config: CompendiumTabConfig = { name: 'Unknown' },
): PlainRow[] {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('Empty CSV');
  if (config.navigationOnly) return [];
  const nameHeaders = new Set([
    'name',
    'perk',
    'trait',
    'mod',
    'ability',
    'armor set',
    'exotic',
    'fragment',
    'aspect',
    'weapon',
    'armor',
    ...(config.nameHeaders ?? []).map((s) => s.toLowerCase()),
  ]);
  const descriptionHeaders = new Set([
    'description',
    'descriptions',
    'effect',
    'effects',
    ...(config.descriptionHeaders ?? []).map((s) => s.toLowerCase()),
  ]);
  let groups: CompendiumColumns[] | undefined = config.cards ? config.groups : undefined;
  const result: PlainRow[] = [];
  const previous = new Map<number, PlainRow>();
  const pending = new Map<number, { name: string; csvRow: number }>();
  const previousDescriptions = new Map<number, string[]>();
  const consumedCardRows = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (consumedCardRows.has(index)) continue;
    const populated = row.filter((value) => value.trim());
    if (
      config.cards &&
      populated.length === 1 &&
      /^(?:Season of |Archive of |For older Artifact Mods)/i.test(populated[0].trim())
    )
      continue;
    const names = row.flatMap((value, col) =>
      nameHeaders.has(value.trim().toLowerCase()) ? [col] : [],
    );
    const descriptions = row.flatMap((value, col) =>
      descriptionHeaders.has(value.trim().toLowerCase()) ? [col] : [],
    );
    if (names.length && descriptions.length) {
      groups = [];
      let pendingNames: number[] = [];
      for (let column = 0; column < row.length; column++) {
        if (names.includes(column)) pendingNames.push(column);
        if (!descriptions.includes(column)) continue;
        if (pendingNames.length) {
          groups.push({ nameColumns: pendingNames, descriptionColumns: [column] });
          pendingNames = [];
        } else groups.at(-1)?.descriptionColumns.push(column);
      }
      previous.clear();
      pending.clear();
      previousDescriptions.clear();
      continue;
    }
    const override = Object.entries(config.sectionOverrides ?? {}).find(([header]) =>
      row.some((value) => value.startsWith(header)),
    );
    const marker = row.some((value) =>
      config.sectionHeaders?.some((header) => value.trim().toLowerCase() === header.toLowerCase()),
    );
    if (override || marker) {
      groups =
        override?.[1] ??
        groups ??
        config.groups ??
        (config.nameColumns && config.descriptionColumns
          ? [{ nameColumns: config.nameColumns, descriptionColumns: config.descriptionColumns }]
          : undefined);
      previous.clear();
      pending.clear();
      previousDescriptions.clear();
      continue;
    }
    if (!groups) continue;
    for (const [group, columns] of groups.entries()) {
      const rawName = columns.nameColumns.map((col) => row[col] ?? '');
      const name = rawName
        .map((value) => value.trim())
        .filter(Boolean)
        .join(' ');
      const descriptionRow = config.cards ? rows[index + 1] : row;
      const descriptionValues = columns.descriptionColumns.map(
        (col) => descriptionRow?.[col] ?? '',
      );
      // Grenade enhancement rows share the base grenade's merged cooldown cell.
      // Unlike fragment stats, a missing value here means inherited, not absent.
      if (/^(Touch of (?:Thunder|Flame|Winter)|Chaos Accelerant|Mindspun Invocation)/.test(name)) {
        const prior = previousDescriptions.get(group);
        for (let i = 1; i < descriptionValues.length; i++) {
          if (!descriptionValues[i].trim() && prior?.[i]?.startsWith('Base Cooldown:')) {
            descriptionValues[i] = prior[i];
          }
        }
      }
      const text = descriptionValues.filter((s) => s.trim()).join('\n');
      if (!name && text && !config.cards) {
        const label = pending.get(group);
        if (label) {
          const entry = { ...label, text };
          result.push(entry);
          previous.set(group, entry);
          previousDescriptions.set(group, descriptionValues);
          pending.delete(group);
        } else {
          const entry = previous.get(group);
          // Prismatic's glossary has standalone, unnamed guidance paragraphs.
          // Its named multi-row Shared Abilities tables are different.
          if (entry && (config.name !== 'Prismatic' || entry.name.startsWith('Shared Abilities'))) {
            entry.text += '\n' + text;
          }
        }
      } else if (name && text) {
        const entry = { name, text, csvRow: index + 1 };
        result.push(entry);
        previous.set(group, entry);
        previousDescriptions.set(group, descriptionValues);
        pending.delete(group);
        if (config.cards) consumedCardRows.add(index + 1);
      } else if (
        name &&
        populated.length > 1 &&
        previous.has(group) &&
        !config.cards &&
        (config.descriptionHeaders?.includes('Notes') || /\[[\d -]+Energy\]/i.test(name))
      ) {
        // Parallel-table aliases and consecutive perks may share a merged
        // description. CSV exposes its value only at the merge's top-left.
        result.push({ name, text: previous.get(group)!.text, csvRow: index + 1 });
        pending.delete(group);
      } else if (name) {
        previous.delete(group);
        previousDescriptions.delete(group);
        if (name.includes('\n')) pending.set(group, { name, csvRow: index + 1 });
        else pending.delete(group);
      }
    }
  }
  if (!groups?.length)
    throw new Error(`No CSV name/description layout recognized for ${config.name}`);
  if (!result.length) throw new Error(`No named CSV rows found for ${config.name}`);
  return result;
}

export function compareSheet(expected: PlainRow[], parsed: ParsedRow[]) {
  const remaining = new Set(parsed.map((_, index) => index));
  const mismatches: Mismatch[] = [];
  for (const entry of expected) {
    const candidates = [...remaining].filter(
      (index) => whitespace(parsed[index].name) === whitespace(entry.name),
    );
    const exact = candidates.find(
      (index) => whitespace(parsed[index].cell.plain) === whitespace(entry.text),
    );
    const selected = exact ?? candidates[0];
    if (selected === undefined) {
      mismatches.push({
        kind: 'missing',
        name: entry.name,
        csvRow: entry.csvRow,
        expected: entry.text,
      });
      continue;
    }
    remaining.delete(selected);
    if (exact === undefined)
      mismatches.push({
        kind: 'text',
        name: entry.name,
        csvRow: entry.csvRow,
        parsedRow: parsed[selected].rowIndex,
        expected: entry.text,
        actual: parsed[selected].cell.plain,
      });
  }
  for (const index of remaining)
    mismatches.push({
      kind: 'unexpected',
      name: parsed[index].name,
      parsedRow: parsed[index].rowIndex,
      actual: parsed[index].cell.plain,
    });
  return { csvNamedRows: expected.length, parsedNamedRows: parsed.length, mismatches };
}
