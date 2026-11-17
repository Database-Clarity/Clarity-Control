import {
  lowerConsumerMarkup,
  lowerDelimitedMarkup,
  lowerExoticMarkup,
} from '@clarity/core/markup/braces';
import type { LegacyInput } from './legacy.js';

/**
 * Element-tagged text (`<solar Scorch />`) in the published input becomes today's format
 * (`<solar/>Scorch`, core's lowerElementTags) before any file is built, so every legacy file and
 * every default configured file is byte for byte what the lowered form, written by hand, builds.
 * Custom files can opt into elementTags, retaining authored tags for the parser's tint metadata.
 * Delimited
 * variables (`#{d}`) and the arrow symbol (`<enhanced/>`) lower the same way (core braces.ts). The
 * editor's exporters already lower (core exportLegacy); this keeps the engine exact on any input.
 * Unresolved number tokens fail closed: only core exportLegacy has their English slot map.
 * Input without those forms comes back as the same object, so nothing is copied.
 */
export function lowerInput<T extends LegacyInput>(
  input: T,
  arrow?: 'legacy' | 'fallback',
  elementTags = false,
): T {
  const lower = (text: string) =>
    elementTags ? lowerDelimitedMarkup(lowerExoticMarkup(text)) : lowerConsumerMarkup(text, arrow);
  let perks: LegacyInput['perks'] | undefined;
  for (const [hash, perk] of Object.entries(input.perks)) {
    if (!('editor' in perk) || !perk.editor) continue;
    let editor: typeof perk.editor | undefined;
    for (const [language, text] of Object.entries(perk.editor)) {
      if (!text) continue;
      // Only core exportLegacy has the English slot map needed to resolve these.
      if (text.main.includes('#{=') || text.secondary.includes('#{='))
        throw new Error(`Unresolved number token in ${hash}/${language}`);
      const main = lower(text.main);
      const secondary = lower(text.secondary);
      if (main === text.main && secondary === text.secondary) continue;
      editor ??= { ...perk.editor };
      editor[language as keyof typeof editor] = { ...text, main, secondary };
    }
    if (!editor) continue;
    perks ??= { ...input.perks };
    perks[hash] = { ...perk, editor };
  }
  return perks ? { ...input, perks } : input;
}
