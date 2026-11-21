import { languages, usesEnglishFallback, validateTextWithReads, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { dependencyChunks } from '../dependencyChunks';
import { saveDependencies } from './dependencies';
import { liveForm, validateChanges } from './validation';
import { jsonBytes, saveEnvelopeBytes, saveRequestLimits } from './requestSize';

const fallbackLanguages = (tooltip: Tooltip) =>
  languages.filter((lang) => usesEnglishFallback(tooltip, lang));

export function saveChunks(
  changes: Change[],
  data: EditorData,
  message: string,
  noTranslationImpact: boolean,
): Change[][] {
  const envelope = saveEnvelopeBytes(message, noTranslationImpact);
  const bytes = new Map(changes.map((change) => [change.hash, jsonBytes(change)]));
  const fits = (items: readonly Change[]) =>
    items.length <= saveRequestLimits.changes &&
    items.reduce((size, item) => size + bytes.get(item.hash)! + 1, envelope - 1) <=
      saveRequestLimits.bytes;
  if (fits(changes)) return [changes];

  const tooltips = { ...data.bundle.tooltips };
  const dependencies = new Map(changes.map(({ hash }) => [hash, new Set<number>()]));
  for (const { hash, next } of changes) tooltips[hash] = liveForm(next, fallbackLanguages(next));
  const { globalsFor } = saveDependencies(changes, data.bundle.tooltips, tooltips, data);
  for (const lang of languages) {
    for (const { hash, next } of changes) {
      const found = dependencies.get(hash)!;
      const live = tooltips[hash]?.text[lang]?.text;
      const raw = next.text[lang]?.text;
      for (const text of new Set([live, raw])) {
        if (text === undefined) continue;
        const { reads } = validateTextWithReads(
          text,
          lang,
          globalsFor(hash, lang),
          false,
          hash,
          data.aliases,
        );
        for (const target of reads.imports.values())
          if (dependencies.has(target)) found.add(target);
        if (reads.variables.size && dependencies.has(2)) found.add(2);
        if (dependencies.has(3)) found.add(3);
      }
    }
  }
  const chunks = dependencyChunks<Change & { dependencies: number[] }>(
    changes.map((change) => ({ ...change, dependencies: [...dependencies.get(change.hash)!] })),
    {
      fits,
      missing: (hash) => `Tooltip ${hash} is missing from this save.`,
      duplicate: 'This save contains duplicate tooltips.',
      tooLarge: (hash) =>
        `Tooltip ${hash} and the tooltips it depends on could not be saved together. The drafts are retained.`,
    },
  ).map((chunk) => chunk.map(({ hash, base, next }) => ({ hash, base, next })));

  // A target may also remove an import still used by saved text. Check each intermediate
  // catalogue before sending anything, using the same live validator as the review.
  let snapshot = data;
  for (const chunk of chunks) {
    const fallback = Object.fromEntries(
      chunk.map(({ hash, next }) => [hash, fallbackLanguages(next)]),
    );
    const issue = validateChanges(chunk, snapshot, fallback).find(
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
