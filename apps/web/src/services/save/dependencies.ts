import {
  extractVariables,
  languages,
  resolveAlias,
  usesEnglishFallback,
  validateTextWithReads,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
  type TooltipValidationIssue,
  type ValidationReads,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { languageLabel } from '../../languageLabels';
import type { Change } from '../api';
import { tooltipImports } from '../tooltipImports';
import type { LiveFallback } from './fallback';

type Dependent = {
  hash: number;
  lang: Lang;
  validation: ReturnType<typeof validateTextWithReads>;
};
type Baseline = { index: Map<number, Set<Dependent>>; entries: Dependent[] };
// EditorData is immutable: load, refresh, conflict reload, and acceptSaved replace it.
// This also invalidates aliases, category types, globals, and titles, even at the same commit.
const baselines = new WeakMap<EditorData, Map<Lang, Baseline>>();

/**
 * The text live output exports for a stored tooltip (core exportLegacy): a translation more than
 * 90 days of English revisions behind is the English text. Used for every tooltip whose stamps are
 * real (saved tooltips and draft bases), so imports and dependents resolve as live output does.
 */
const liveText = (tooltip: Tooltip | undefined, lang: Lang) =>
  (lang !== 'en' && tooltip && usesEnglishFallback(tooltip, lang)
    ? tooltip.text.en?.text
    : tooltip?.text[lang]?.text) ?? '';

/** `tooltips` with `textOf`'s text in `lang` (the same record when every text is already it). */
function liveTooltips(
  tooltips: Record<string, Tooltip>,
  lang: Lang,
  textOf: (tooltip: Tooltip) => string,
): Record<string, Tooltip> {
  if (lang === 'en') return tooltips;
  let live: Record<string, Tooltip> | undefined;
  for (const [hash, tooltip] of Object.entries(tooltips)) {
    const entry = tooltip.text[lang];
    if (!entry) continue;
    const text = textOf(tooltip);
    if (entry.text === text) continue;
    live ??= { ...tooltips };
    live[hash] = { ...tooltip, text: { ...tooltip.text, [lang]: { ...entry, text } } };
  }
  return live ?? tooltips;
}

function changedNames(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) =>
      before[name] !== after[name] || Object.hasOwn(before, name) !== Object.hasOwn(after, name),
  );
}

/** Save-only snapshots and reverse index. Dependency discovery always runs the real validator. */
export function saveDependencies(
  changes: readonly Change[],
  before: Record<string, Tooltip>,
  after: Record<string, Tooltip>,
  data: EditorData,
  fallback: LiveFallback = {},
) {
  // Catalogues and dependents read live text (EXPORT-FALLBACK-VALIDATION): an import of a
  // tooltip whose translation falls back reads its English, as live output does.
  const changedHashes = new Set(changes.map(({ hash }) => hash));
  // A changed tooltip's draft stamps are not the saved ones yet. Its text in `after` already holds
  // the save's predicted fallback (validation.withLiveFallback); a language whose text and English
  // text both stay keeps its stamps, so its stored fallback state.
  const afterText = (tooltip: Tooltip, lang: Lang) => {
    if (!changedHashes.has(tooltip.hash)) return liveText(tooltip, lang);
    const old = before[tooltip.hash];
    return old &&
      old.text.en?.text === tooltip.text.en?.text &&
      old.text[lang]?.text === tooltip.text[lang]?.text
      ? liveText(old, lang)
      : (tooltip.text[lang]?.text ?? '');
  };
  const catalogs = (
    tooltips: Record<string, Tooltip>,
    textOf: (tooltip: Tooltip, lang: Lang) => string,
  ) => {
    const cache = new Map<Lang, Record<string, string>>();
    return (lang: Lang) => {
      let catalog = cache.get(lang);
      if (!catalog)
        cache.set(
          lang,
          (catalog = tooltipImports(
            liveTooltips(tooltips, lang, (tooltip) => textOf(tooltip, lang)),
            {},
            lang,
            data.aliases,
          )),
        );
      return catalog;
    };
  };
  const beforeCatalog = catalogs(before, liveText);
  const afterCatalog = catalogs(after, afterText);
  const globalsFor = (hash: number, lang: Lang, saved = false): MarkupGlobals => {
    const catalog = (saved ? beforeCatalog : afterCatalog)(lang);
    const item = data.items[hash];
    return {
      variables: catalog[2] ?? '',
      titles: catalog[3] ?? '',
      imports: catalog,
      type: data.categories.find((category) => category.id === item?.categoryId)?.legacyType,
    };
  };
  const changed = new Map<Lang, Map<number, string>>();
  const names = new Map<Lang, { name: string; label: string }[]>();
  for (const lang of languages) {
    const documents = new Map<number, string>();
    const globals: { name: string; label: string }[] = [];
    for (const { hash } of changes) {
      const oldText = liveText(before[hash], lang);
      const newText = after[hash] ? afterText(after[hash], lang) : '';
      if (oldText === newText) continue;
      documents.set(
        hash,
        `"${data.items[hash]?.name ?? `Tooltip ${hash}`}" (${hash})${fallback[hash]?.includes(lang) ? ` (live ${languageLabel(lang)} output falls back to its English text)` : ''}`,
      );
      if (hash === 2) {
        globals.push(
          ...changedNames(extractVariables(oldText), extractVariables(newText)).map((name) => ({
            name,
            label: `the global variable "${name}"`,
          })),
        );
      }
    }
    if (documents.size) changed.set(lang, documents);
    names.set(lang, globals);
  }
  const affectedBy = (reads: ValidationReads): string | undefined => {
    const documents = changed.get(reads.lang);
    if (!documents) return undefined;
    for (const hash of reads.imports.values()) {
      if (documents.has(hash)) return documents.get(hash);
    }
    // Every global title body is prepared for every text, even when its title is not used.
    if (documents.has(3)) return documents.get(3);
    for (const { name, label } of names.get(reads.lang)!) {
      if (reads.variables.has(name)) return label;
    }
    return undefined;
  };

  const outsideIssues = (): TooltipValidationIssue[] => {
    const batch = changedHashes;
    const dependents = new Set<Dependent>();
    // Build once, only for languages whose inputs change. The baseline reads also select texts
    // whose after-expansion reads a new target: its first changed input was read before the save.
    for (const [lang, documents] of changed) {
      const isSavedBaseline =
        Object.keys(before).length === Object.keys(data.bundle.tooltips).length &&
        Object.keys(before).every((hash) => before[hash] === data.bundle.tooltips[hash]);
      let cache = baselines.get(data);
      if (!cache) baselines.set(data, (cache = new Map()));
      let baseline = isSavedBaseline ? cache.get(lang) : undefined;
      if (!baseline) {
        const index = new Map<number, Set<Dependent>>();
        const entries: Dependent[] = [];
        for (const tooltip of Object.values(before)) {
          const hash = tooltip.hash;
          if (resolveAlias(hash, data.aliases) !== hash) continue;
          if (lang !== 'en' && !tooltip.text[lang]) continue;
          const validation = validateTextWithReads(
            liveText(tooltip, lang),
            lang,
            globalsFor(hash, lang, true),
            false,
            hash,
            data.aliases,
          );
          const dependent = { hash, lang, validation };
          entries.push(dependent);
          for (const target of validation.reads.imports.values()) {
            let users = index.get(target);
            if (!users) index.set(target, (users = new Set()));
            users.add(dependent);
          }
        }
        baseline = { index, entries };
        if (isSavedBaseline) cache.set(lang, baseline);
      }
      const { index, entries } = baseline;
      for (const dependent of entries) {
        if (
          !batch.has(dependent.hash) &&
          affectedBy({ ...dependent.validation.reads, imports: new Map() })
        ) {
          dependents.add(dependent);
        }
      }
      for (const hash of documents.keys()) {
        for (const dependent of index.get(hash) ?? []) {
          if (!batch.has(dependent.hash)) dependents.add(dependent);
        }
      }
    }
    const issues: TooltipValidationIssue[] = [];
    for (const { hash, lang, validation: baseline } of dependents) {
      const next = validateTextWithReads(
        afterText(after[hash], lang),
        lang,
        globalsFor(hash, lang),
        false,
        hash,
        data.aliases,
      );
      const uses = affectedBy(next.reads) ?? affectedBy(baseline.reads);
      const oldErrors = new Set(
        baseline.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
      );
      for (const issue of next.issues) {
        // Diagnostic messages merge equal failures from distinct paths. When a read changed,
        // retaining an old message cannot prove the save did not introduce another failure (P7).
        const error = issue.severity === 'error' && uses !== undefined;
        issues.push({
          ...issue,
          hash,
          lang,
          severity: error ? 'error' : 'warning',
          message: error
            ? `${issue.message} Dependent tooltip "${data.items[hash]?.name ?? `Tooltip ${hash}`}" (${hash}) uses ${uses}, which this save changes.${oldErrors.has(issue.message) ? ' An existing diagnostic can also hide a new failure on another import path.' : ''} Fix the dependent, or include its repair in this save.`
            : issue.message,
        });
      }
    }
    return issues;
  };
  return { globalsFor, affectedBy, outsideIssues };
}
