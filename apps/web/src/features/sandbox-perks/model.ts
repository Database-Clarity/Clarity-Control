import {
  enhancedMarkupType,
  hasTooltipText,
  languages,
  parseMarkup,
  resolveAlias,
  sandboxPointerChanged,
  usesEnglishFallback,
  type Aliases,
  type Lang,
  type SandboxConflicts,
  type SandboxPick,
  type SandboxPointer,
  type SandboxPointers,
  type Tooltip,
} from '@clarity/core';
import type { Item } from '../../services/generatorSchema';
import { tooltipImports } from '../../services/tooltipImports';
import type { SandboxPerkText } from '../manifest/manifestText';

/** The worklist's pre-filled choice (design 2026-11-12); a maintainer confirms every row. */
export type Bucket = 'same-text' | 'name-match' | 'same-name' | 'suggest-none' | 'judgement';
export type Kind = 'armour' | 'weapon' | 'catalyst' | 'frame' | 'subclass';

export const bucketLabels: Record<Bucket, string> = {
  'same-text': 'Same text after imports',
  'name-match': 'Name matches one',
  'same-name': 'Same name, different text',
  'suggest-none': 'Suggest no tooltip',
  judgement: 'Needs judgement',
};
export const kindLabels: Record<Kind, string> = {
  armour: 'Armour',
  weapon: 'Weapon perks',
  catalyst: 'Catalysts',
  frame: 'Frames',
  subclass: 'Subclass',
};

export interface Candidate {
  /** The canonical tooltip the generator's candidate resolves to. */
  hash: number;
  name: string;
  categoryId: string;
  /** First English line, for the Choose list. */
  firstLine: string;
  hasText: boolean;
}

export interface SandboxRow {
  hash: string;
  /** Bungie's own name for the effect; empty when it has none. */
  name: string;
  firstLine: string;
  candidates: Candidate[];
  kind: Kind;
  bucket: Bucket;
  /** The suggested pick, when the bucket has one. */
  suggestion?: SandboxPick;
  saved?: SandboxPointer;
  /** Saved pick whose candidate set changed since (or the perk is no longer shared). */
  changed: boolean;
  /** No longer listed by the generator (only kept so a saved pick can be undone). */
  retired: boolean;
}

export interface WorklistInput {
  conflicts: SandboxConflicts;
  /** The generator's own aliases (picks are the thing being edited here). */
  aliases: Aliases;
  tooltips: Readonly<Record<string, Tooltip>>;
  items: Readonly<Record<string, Item>>;
  perkText: SandboxPerkText;
  saved: SandboxPointers;
}

const wholeImport = /^\s*import main from (\d+)\s*$/;
const noTooltipName =
  /^(deprecated perk|unlocked by quest)$|^\[[^\]]+\]|^[+-]\d+(\.\d+)?%? [^\n]*[▲▼]?$/i;

function firstLine(text: string | undefined): string {
  return (
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('//')) ?? ''
  );
}

/** English source after whole-text `import main from X` chains: the tooltip whose text it is. */
function textRoot(hash: number, input: WorklistInput): number {
  const seen = new Set<number>();
  let current = hash;
  while (!seen.has(current)) {
    seen.add(current);
    const english = input.tooltips[current]?.text.en?.text ?? '';
    const match = wholeImport.exec(
      english
        .split('\n')
        .filter((line) => line.trim() && !line.trim().startsWith('//'))
        .join('\n'),
    );
    if (!match) return current;
    current = resolveAlias(Number(match[1]), input.aliases);
  }
  return current;
}

function kindOf(categoryIds: readonly string[]): Kind {
  if (categoryIds.some((id) => id.includes('catalyst'))) return 'catalyst';
  if (categoryIds.some((id) => id.startsWith('weapon-frame'))) return 'frame';
  if (categoryIds.some((id) => id.startsWith('subclass-'))) return 'subclass';
  if (categoryIds.some((id) => id.startsWith('armor-'))) return 'armour';
  return 'weapon';
}

const norm = (name: string) => name.trim().toLowerCase();

function suggest(
  name: string,
  candidates: readonly Candidate[],
  input: WorklistInput,
): Pick<SandboxRow, 'bucket' | 'suggestion'> {
  const roots = new Set(candidates.map((candidate) => textRoot(candidate.hash, input)));
  const [root] = roots;
  if (
    roots.size === 1 &&
    root !== undefined &&
    input.tooltips[root] &&
    hasTooltipText(input.tooltips[root])
  )
    return { bucket: 'same-text', suggestion: { to: root } };
  if (!name || noTooltipName.test(name))
    return { bucket: 'suggest-none', suggestion: { none: true } };
  const named = candidates.filter((candidate) => norm(candidate.name) === norm(name));
  if (named.length === 1 && named[0]!.hasText)
    return { bucket: 'name-match', suggestion: { to: named[0]!.hash } };
  if (named.length === candidates.length) return { bucket: 'same-name' };
  return { bucket: 'judgement' };
}

/** One row per shared sandbox perk, plus saved picks the generator no longer lists. */
export function buildRows(input: WorklistInput): SandboxRow[] {
  const hashes = new Set([...Object.keys(input.conflicts), ...Object.keys(input.saved.pointers)]);
  const rows: SandboxRow[] = [];
  for (const hash of [...hashes].sort((a, b) => Number(a) - Number(b))) {
    const listed = input.conflicts[hash];
    const saved = input.saved.pointers[hash];
    const raw = listed ?? saved?.candidates ?? [];
    const categoryIds: string[] = [];
    const candidates: Candidate[] = [];
    for (const identity of raw) {
      const canonical = resolveAlias(identity, input.aliases);
      const item = input.items[identity] ?? input.items[canonical];
      if (item) categoryIds.push(item.categoryId);
      if (candidates.some((candidate) => candidate.hash === canonical)) continue;
      const tooltip = input.tooltips[canonical];
      const own = input.items[canonical];
      candidates.push({
        hash: canonical,
        name: own?.name ?? tooltip?.custom?.name ?? item?.name ?? String(canonical),
        categoryId: own?.categoryId ?? tooltip?.custom?.categoryId ?? item?.categoryId ?? '',
        firstLine: firstLine(tooltip?.text.en?.text),
        hasText: Boolean(tooltip && hasTooltipText(tooltip)),
      });
    }
    const text = input.perkText[hash];
    const name = text?.[0].trim() ?? '';
    rows.push({
      hash,
      name,
      firstLine: firstLine(text?.[1]),
      candidates,
      kind: kindOf(categoryIds),
      ...suggest(name, candidates, input),
      ...(saved ? { saved } : {}),
      changed: Boolean(saved && sandboxPointerChanged(hash, saved, input.conflicts)),
      retired: !listed,
    });
  }
  return rows;
}

export type StatusFilter = 'open' | Bucket | 'decided' | 'changed' | 'all';

/** Filters read the SAVED state, so a row stays in view (with Undo) after a staged decision. */
export function matches(row: SandboxRow, status: StatusFilter, kind: Kind | '', query: string) {
  if (kind && row.kind !== kind) return false;
  const ok =
    status === 'all'
      ? true
      : status === 'decided'
        ? Boolean(row.saved)
        : status === 'changed'
          ? row.changed
          : !row.saved && !row.retired && (status === 'open' || row.bucket === status);
  if (!ok) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.hash.includes(q) ||
    row.name.toLowerCase().includes(q) ||
    row.candidates.some((candidate) => candidate.name.toLowerCase().includes(q))
  );
}

/** The pick a row has once staged changes apply: staged null = undone. */
export function effectivePick(
  row: SandboxRow,
  staged: Readonly<Record<string, SandboxPick | null>>,
): SandboxPick | undefined {
  if (Object.hasOwn(staged, row.hash)) return staged[row.hash] ?? undefined;
  return row.saved ? ('to' in row.saved ? { to: row.saved.to } : { none: true }) : undefined;
}

/** The complete set of picks a save sends: every saved pick with the staged changes applied. */
export function picksToSave(
  saved: SandboxPointers,
  staged: Readonly<Record<string, SandboxPick | null>>,
): Record<string, SandboxPick> {
  const picks: Record<string, SandboxPick> = {};
  for (const [hash, pointer] of Object.entries(saved.pointers))
    picks[hash] = 'to' in pointer ? { to: pointer.to } : { none: true };
  for (const [hash, pick] of Object.entries(staged)) {
    if (pick) picks[hash] = pick;
    else delete picks[hash];
  }
  return picks;
}

// ---- compiled check (owner 2026-11-12: bulk only after a compiled check in every language and
// base/enhanced form) ----

/** The forms a perk compiles in: base (no perk type) and enhanced (`<enhanced>` blocks, `{{a}{b}}`). */
const forms = [undefined, enhancedMarkupType] as const;

export interface CompileContext {
  tooltips: Readonly<Record<string, Tooltip>>;
  aliases: Aliases;
  cache: Map<string, string>;
}

/**
 * What a consumer receives for `hash` in `lang` and `form`, as the editor's compiler (core
 * parseMarkup: imports, globals, conditions, base/enhanced pairs, variables, math) renders it.
 * The text exported is the stale-translation English fallback where that applies; a missing
 * language compiles to a marker, so a translation present on one candidate only differs.
 */
export function compiled(
  hash: number,
  lang: Lang,
  form: (typeof forms)[number],
  context: CompileContext,
): string {
  const key = `${hash}:${lang}:${form ?? ''}`;
  const hit = context.cache.get(key);
  if (hit !== undefined) return hit;
  const tooltip = context.tooltips[hash];
  const entry = tooltip?.text[lang];
  let result = '\u0000missing';
  if (tooltip && entry?.text.trim()) {
    const text = usesEnglishFallback(tooltip, lang) ? tooltip.text.en!.text : entry.text;
    const imports = tooltipImports(
      context.tooltips as Record<string, Tooltip>,
      {},
      lang,
      context.aliases,
    );
    result = JSON.stringify(
      parseMarkup(text, {
        imports,
        variables: imports['2'] ?? '',
        titles: imports['3'] ?? '',
        ...(form ? { type: form } : {}),
      }).lines,
    );
  }
  context.cache.set(key, result);
  return result;
}

/** The first language and form where the candidates' compiled output differs, or null. */
export function compiledDifference(
  candidates: readonly number[],
  context: CompileContext,
): { lang: Lang; form: 'base' | 'enhanced' } | null {
  for (const lang of languages)
    for (const form of forms) {
      const outputs = new Set(candidates.map((hash) => compiled(hash, lang, form, context)));
      if (outputs.size > 1) return { lang, form: form ? 'enhanced' : 'base' };
    }
  return null;
}

export interface BulkResult {
  applied: string[];
  skipped: { hash: string; name: string; reason: string }[];
}

/**
 * Bulk accept of same-text rows: a row is applied only when every candidate compiles to the same
 * output in every language and both forms. Yields to the browser between language/form steps
 * (~8 ms slices), so a large batch never blocks input.
 */
export async function bulkCheck(
  rows: readonly SandboxRow[],
  context: CompileContext,
  onProgress?: (done: number) => void,
  yieldToBrowser: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<BulkResult> {
  const result: BulkResult = { applied: [], skipped: [] };
  let slice = performance.now();
  for (const [index, row] of rows.entries()) {
    if (row.bucket !== 'same-text' || !row.suggestion || !('to' in row.suggestion)) {
      result.skipped.push({ hash: row.hash, name: row.name, reason: 'no same-text suggestion' });
      continue;
    }
    const hashes = row.candidates.map((candidate) => candidate.hash);
    let difference: string | undefined;
    for (const lang of languages) {
      for (const form of forms) {
        if (performance.now() - slice > 8) {
          onProgress?.(index);
          await yieldToBrowser();
          slice = performance.now();
        }
        if (new Set(hashes.map((hash) => compiled(hash, lang, form, context))).size > 1)
          difference = `${lang}, ${form ? 'enhanced' : 'base'}`;
        if (difference) break;
      }
      if (difference) break;
    }
    if (difference)
      result.skipped.push({
        hash: row.hash,
        name: row.name,
        reason: `compiled output differs (${difference})`,
      });
    else result.applied.push(row.hash);
  }
  onProgress?.(rows.length);
  return result;
}
