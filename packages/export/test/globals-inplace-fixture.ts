import {
  globalsInPlaceLibraryText,
  languages,
  resolveGlobalsInPlace,
  type GlobalsInPlaceDefinitions,
} from '@clarity/core';
import { extractBlocks, extractVariables } from '../../core/src/markup/syntax.js';
import type { LegacyInput } from '../src/index.js';

/** Read the two legacy parts in the same order as the consumers, including secondary overrides. */
export function readFixtureGlobals(input: LegacyInput): GlobalsInPlaceDefinitions {
  const definitions = {
    exports: {},
    titles: {},
    variables: {},
  } satisfies GlobalsInPlaceDefinitions;
  for (const [hash, kind] of [
    [1, 'exports'],
    [2, 'variables'],
    [3, 'titles'],
  ] as const) {
    const row = input.perks[hash];
    if (!row || !('editor' in row)) throw new Error(`Missing fixture library ${hash}`);
    const entries: Record<string, Record<string, { body: string }>> = definitions[kind];
    for (const lang of languages) {
      const cell = row.editor[lang];
      if (!cell) continue;
      for (const source of [cell.main, cell.secondary]) {
        const bodies =
          kind === 'variables'
            ? extractVariables(source)
            : extractBlocks(source, kind === 'exports' ? 'export' : 'title');
        for (const [name, body] of Object.entries(bodies)) {
          if (!Object.hasOwn(entries, name)) entries[name] = {};
          entries[name][lang] = { body };
        }
      }
    }
  }
  return definitions;
}

export function inlineFixtureGlobals(
  input: LegacyInput,
  definitions = readFixtureGlobals(input),
): LegacyInput {
  const result = structuredClone(input);
  for (const row of Object.values(result.perks)) {
    if (!('editor' in row)) continue;
    const sentinel = globalsInPlaceLibraryText(row.hash);
    if (sentinel === '') {
      row.editor = {};
      continue;
    }
    for (const lang of languages) {
      const cell = row.editor[lang];
      if (!cell) continue;
      if (sentinel) row.editor[lang] = { main: sentinel, secondary: '' };
      else {
        cell.main = resolveGlobalsInPlace(cell.main, lang, { definitions });
        cell.secondary = resolveGlobalsInPlace(cell.secondary, lang, { definitions });
      }
    }
  }
  return result;
}
