import { languages, usesEnglishFallback, validateTextWithReads, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { dependencyChunks } from '../dependencyChunks';
import { saveDependencies } from './dependencies';
import { liveForm, validateChanges } from './validation';
import { fitsSaveCosts, saveChangeCost, saveEnvelopeBytes } from './requestSize';

const fallbackLanguages = (tooltip: Tooltip) =>
  languages.filter((lang) => usesEnglishFallback(tooltip, lang));

export function saveChunks(
  changes: Change[],
  data: EditorData,
  message: string,
  noTranslationImpact: boolean,
): Change[][] {
  const envelope = saveEnvelopeBytes(message, noTranslationImpact);
  const cost = new Map(changes.map((change) => [change.hash, saveChangeCost(change)]));
  const fits = (items: readonly Change[]) =>
    fitsSaveCosts(items, envelope, ({ hash }) => cost.get(hash)!);
  if (fits(changes)) return [changes];

  const tooltips = { ...data.bundle.tooltips };
  const dependencies = new Map(changes.map(({ hash }) => [hash, new Set<number>()]));
  for (const { hash, next } of changes) tooltips[hash] = liveForm(next, fallbackLanguages(next));
  const { globalsFor } = saveDependencies(changes, data.bundle.tooltips, tooltips, data);
  for (const lang of languages) {
    for (const { hash, base, next } of changes) {
      const found = dependencies.get(hash)!;
      const live = tooltips[hash]?.text[lang]?.text;
      const raw = next.text[lang]?.text;
      const previous = base && (usesEnglishFallback(base, lang) ? base.text.en : base.text[lang]);
      if (live === undefined && raw === undefined && !previous) continue;
      const globals = globalsFor(hash, lang);
      for (const text of new Set([live, raw])) {
        if (text === undefined) continue;
        const { reads } = validateTextWithReads(text, lang, globals, false, hash, data.aliases);
        for (const target of reads.imports.values())
          if (dependencies.has(target)) found.add(target);
        if (reads.variables.size && dependencies.has(2)) found.add(2);
        if (dependencies.has(3)) found.add(3);
      }
      // If editing a target would break the importer's old text, land the repair of
      // that importer first (or together, if its new text also needs the target).
      if (previous && previous.text !== live) {
        const checked = validateTextWithReads(
          previous.text,
          lang,
          globals,
          false,
          hash,
          data.aliases,
        );
        if (checked.issues.some(({ severity }) => severity === 'error')) {
          const baseline = validateTextWithReads(
            previous.text,
            lang,
            globalsFor(hash, lang, true),
            false,
            hash,
            data.aliases,
          );
          const oldErrors = new Set(
            baseline.issues
              .filter(({ severity }) => severity === 'error')
              .map(({ message }) => message),
          );
          if (
            checked.issues.some(
              ({ severity, message }) => severity === 'error' && !oldErrors.has(message),
            )
          ) {
            for (const target of baseline.reads.imports.values())
              dependencies.get(target)?.add(hash);
            if (baseline.reads.variables.size) dependencies.get(2)?.add(hash);
            dependencies.get(3)?.add(hash);
          }
        }
      }
    }
  }
  const chunks = dependencyChunks<Change & { dependencies: number[] }>(
    changes.map((change) => ({ ...change, dependencies: [...dependencies.get(change.hash)!] })),
    {
      fits,
      splitDependencies: true,
      missing: (hash) => `Tooltip ${hash} is missing from this save.`,
      duplicate: 'This save contains duplicate tooltips.',
    },
  ).map((chunk) =>
    chunk.map(({ hash, base, next, translationRevisions }) => ({
      hash, base, next, ...(translationRevisions && { translationRevisions }),
    })),
  );

  // A target may also remove an import still used by saved text. Check each intermediate
  // catalogue before sending anything, using the same live validator as the review.
  if (
    !changes.some(({ base, next }) =>
      languages.some(
        (lang) =>
          base?.text[lang]?.text !== next.text[lang]?.text ||
          (base && usesEnglishFallback(base, lang) !== usesEnglishFallback(next, lang)),
      ),
    )
  )
    return chunks;
  let snapshot = data;
  for (const chunk of chunks) {
    const fallback = Object.fromEntries(
      chunk.map(({ hash, next }) => [hash, fallbackLanguages(next)]),
    );
    // Whether the save may clear English text was decided before it was split.
    const issue = validateChanges(chunk, snapshot, fallback, true).find(
      ({ severity }) => severity === 'error',
    );
    if (issue)
      throw new Error(`The save would temporarily break tooltip ${issue.hash}. ${issue.message}`);
    snapshot = {
      ...snapshot,
      bundle: {
        ...snapshot.bundle,
        tooltips: {
          ...snapshot.bundle.tooltips,
          ...Object.fromEntries(chunk.map(({ hash, next }) => [hash, next])),
        },
      },
    };
  }
  return chunks;
}
