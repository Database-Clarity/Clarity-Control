import { lowerConsumerMarkup } from '@clarity/core/markup/braces';
import type { LegacyInput } from './legacy.js';

/**
 * Element-tagged text (`<solar Scorch />`) in the published input becomes today's format
 * (`<solar/>Scorch`, core's lowerElementTags) before any file is built, so every legacy file and
 * every configured file is byte for byte what the lowered form, written by hand, builds. Delimited
 * variables (`#{d}`) and the arrow symbol (`<enhanced/>`) lower the same way (core braces.ts). The
 * editor's exporters already lower (core exportLegacy); this keeps the engine exact on any input.
 * Input without those forms comes back as the same object, so nothing is copied.
 */
export function lowerInput<T extends LegacyInput>(input: T): T {
  let perks: LegacyInput['perks'] | undefined;
  for (const [hash, perk] of Object.entries(input.perks)) {
    if (!('editor' in perk) || !perk.editor) continue;
    let editor: typeof perk.editor | undefined;
    for (const [language, text] of Object.entries(perk.editor)) {
      if (!text) continue;
      const main = lowerConsumerMarkup(text.main);
      const secondary = lowerConsumerMarkup(text.secondary);
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
