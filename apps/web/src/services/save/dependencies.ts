import {
  extractVariables,
  languages,
  resolveAlias,
  validateTextWithReads,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
  type TooltipValidationIssue,
  type ValidationReads,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { tooltipImports } from '../tooltipImports';

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
) {
  const catalogs = (tooltips: Record<string, Tooltip>) => {
    const cache = new Map<Lang, Record<string, string>>();
    return (lang: Lang) => {
      let catalog = cache.get(lang);
      if (!catalog) cache.set(lang, (catalog = tooltipImports(tooltips, {}, lang, data.aliases)));
      return catalog;
    };
  };
  const beforeCatalog = catalogs(before);
  const afterCatalog = catalogs(after);
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
      const oldText = before[hash]?.text[lang]?.text ?? '';
      const newText = after[hash]?.text[lang]?.text ?? '';
      if (oldText === newText) continue;
      documents.set(hash, `"${data.items[hash]?.name ?? `Tooltip ${hash}`}" (${hash})`);
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
    const batch = new Set(changes.map(({ hash }) => hash));
    type Dependent = {
      hash: number;
      lang: Lang;
      validation: ReturnType<typeof validateTextWithReads>;
    };
    const dependents = new Set<Dependent>();
    // Build once, only for languages whose inputs change. The baseline reads also select texts
    // whose after-expansion reads a new target: its first changed input was read before the save.
    for (const [lang, documents] of changed) {
      const index = new Map<number, Set<Dependent>>();
      for (const tooltip of Object.values(before)) {
        const hash = tooltip.hash;
        if (batch.has(hash) || resolveAlias(hash, data.aliases) !== hash) continue;
        if (lang !== 'en' && !tooltip.text[lang]) continue;
        const validation = validateTextWithReads(
          tooltip.text[lang]?.text ?? '',
          lang,
          globalsFor(hash, lang, true),
          false,
          hash,
          data.aliases,
        );
        const dependent = { hash, lang, validation };
        for (const target of validation.reads.imports.values()) {
          let users = index.get(target);
          if (!users) index.set(target, (users = new Set()));
          users.add(dependent);
        }
        // Global variables are name lookups observed by the same real validation run.
        if (affectedBy({ ...validation.reads, imports: new Map() })) dependents.add(dependent);
      }
      for (const hash of documents.keys()) {
        for (const dependent of index.get(hash) ?? []) dependents.add(dependent);
      }
    }
    const issues: TooltipValidationIssue[] = [];
    for (const { hash, lang, validation: baseline } of dependents) {
      const next = validateTextWithReads(
        after[hash].text[lang]?.text ?? '',
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
