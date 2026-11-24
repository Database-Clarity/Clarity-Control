import { effectiveSharedNotes, extractBlocks } from '@clarity/core';
import { descriptionConverter } from './converter/descriptionConverter.js';
import { expandAliases } from './converter/index.js';
import { lowerInput } from './elementTags.js';
import type { LegacyInput } from './legacy.js';
import { globalsOf, readFormatV2Lines } from './v2/compile.js';
import { exportLanguages, type ExportLanguage } from './v2/vocabulary.js';

type Part = 'main' | 'secondary';
export type InPlaceRefusal = {
  hash: string;
  language: ExportLanguage;
  part: Part;
  message: string;
};

function readerInputs(input: LegacyInput) {
  const legacy = expandAliases(lowerInput(input, 'legacy').perks);
  const v2 = expandAliases(lowerInput(input, undefined, true).perks);
  const globals = new Map(exportLanguages.map((language) => [language, globalsOf(v2, language)]));
  return { legacy, v2, globals };
}

type ReaderInputs = ReturnType<typeof readerInputs>;

function legacyLines(input: ReaderInputs, hash: string, language: ExportLanguage, part: Part) {
  const row = input.legacy[hash];
  const cell = row?.editor[language];
  if (cell === undefined) return;
  return descriptionConverter({
    database: input.legacy,
    descriptionString: cell[part],
    editorType: part,
    hash: row.hash,
    language,
  });
}

function formatV2Lines(input: ReaderInputs, hash: string, language: ExportLanguage) {
  const row = input.v2[hash];
  const cell = row?.editor[language];
  if (cell === undefined) return;
  return readFormatV2Lines(
    cell.main,
    {
      ...input.globals.get(language)!,
      type: row.type,
      lang: cell.englishFallback ? 'en' : language,
    },
    hash,
    language,
  );
}

function refusal(
  input: ReaderInputs,
  after: ReaderInputs,
  hash: string,
  language: ExportLanguage,
  part: Part,
): InPlaceRefusal {
  const row = input.v2[hash] ?? after.v2[hash];
  const name = row?.name || hash;
  const cell = input.v2[hash]?.editor[language];
  const library = input.v2[3]?.editor[language];
  const titles = [library?.main, library?.secondary].filter(Boolean).join('\n');
  const names = new Set(Object.keys(extractBlocks(titles, 'title')));
  const globals = input.globals.get(language)!;
  const imported = new Map<string, string>();
  const remember = (key: PropertyKey) => {
    if (typeof key !== 'string' || key === hash || Number(key) < 50) return;
    const target = input.v2[key];
    if (
      target &&
      target.editor[language] !== undefined &&
      JSON.stringify(target.editor[language]) !== JSON.stringify(after.v2[key]?.editor[language])
    )
      imported.set(key, target.name || key);
  };
  const imports = new Proxy(globals.imports, {
    get(target, key, receiver) {
      remember(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const notes = new Set(
    cell
      ? effectiveSharedNotes(
          cell[part],
          {
            ...globals,
            titles,
            imports,
            type: row.type,
            lang: cell.englishFallback ? 'en' : language,
          },
          names,
        )
      : [],
  );
  try {
    const legacy = new Proxy(input.legacy, {
      get(target, key, receiver) {
        remember(key);
        return Reflect.get(target, key, receiver);
      },
    });
    legacyLines({ ...input, legacy }, hash, language, part);
  } catch {
    // The mismatch already refused this publication.
  }
  for (const key of imported.keys()) {
    const target = input.v2[key];
    const editor = target.editor[language]!;
    for (const source of new Set([editor.main, editor.secondary]))
      for (const note of effectiveSharedNotes(
        source,
        {
          ...globals,
          titles,
          type: target.type,
          lang: editor.englishFallback ? 'en' : language,
        },
        names,
      ))
        notes.add(note);
  }
  const via = imported.size ? ` through the import of ${[...imported.values()].join(', ')}` : '';
  const shared = notes.size ? `the shared note ${[...notes].join(', ')}` : 'shared text';
  return {
    hash,
    language,
    part,
    message: `${name} uses ${shared}${via} in a way that can't be published. Move the note (or the import) out of the block or comment.`,
  };
}

/**
 * Compare the same prospective database before and after filling globals. If supplied, hashes
 * must include every affected importer and its aliases. The default visits the entire database.
 */
export function provesInPlace(
  before: LegacyInput,
  after: LegacyInput,
  hashes: Iterable<string | number> = new Set([
    ...Object.keys(before.perks),
    ...Object.keys(after.perks),
  ]),
): InPlaceRefusal[] {
  const original = readerInputs(before);
  const transformed = readerInputs(after);
  const refusals: InPlaceRefusal[] = [];
  tooltip: for (const value of hashes) {
    const hash = String(value);
    if (Number(hash) < 50) continue;
    const source = original.legacy[hash];
    const target = transformed.legacy[hash];
    // Both publishers select rows using the raw English main field before rendering.
    if (!!source?.editor.en?.main.trim() !== !!target?.editor.en?.main.trim()) {
      refusals.push(refusal(original, transformed, hash, 'en', 'main'));
      continue;
    }
    for (const language of exportLanguages) {
      if (!source?.editor[language] && !target?.editor[language]) continue;
      let equalV2 = false;
      try {
        // Format v2 uses main. The legacy presets still read both parts, including import self.
        equalV2 =
          JSON.stringify(formatV2Lines(original, hash, language)) ===
          JSON.stringify(formatV2Lines(transformed, hash, language));
      } catch {
        // A reader error cannot prove publication safe.
      }
      for (const part of ['main', 'secondary'] as const) {
        let equalLegacy = false;
        try {
          equalLegacy =
            JSON.stringify(legacyLines(original, hash, language, part)) ===
            JSON.stringify(legacyLines(transformed, hash, language, part));
        } catch {
          // A reader error cannot prove publication safe.
        }
        if (!equalLegacy || (part === 'main' && !equalV2)) {
          refusals.push(refusal(original, transformed, hash, language, part));
          continue tooltip;
        }
      }
    }
  }
  return refusals;
}
