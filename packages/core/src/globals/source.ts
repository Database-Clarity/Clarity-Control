import { usesEnglishFallback } from '../exportLegacy.js';
import type { Lang } from '../languages.js';
import { lowerConsumerMarkup } from '../markup/braces.js';
import { numberValues, resolveNumberTokens } from '../numbers/map.js';
import type { Tooltip } from '../schemas.js';

export function globalSourceLanguage(
  tooltip: Tooltip,
  lang: Lang,
  mode: 'authored' | 'live',
): Lang {
  return mode === 'live' && usesEnglishFallback(tooltip, lang) ? 'en' : lang;
}

/** The exact stored or exported input, including missing-language and number-token semantics. */
export function globalSourceText(
  tooltip: Tooltip,
  lang: Lang,
  mode: 'authored' | 'live',
): string | undefined {
  if (!tooltip.text[lang]) return undefined;
  const source = tooltip.text[globalSourceLanguage(tooltip, lang, mode)]!;
  if (mode === 'authored') return source.text;
  const resolved =
    source.text.includes('#{=') && tooltip.text.en
      ? resolveNumberTokens(source.text, numberValues(tooltip.text.en, lang))
      : source.text;
  return lowerConsumerMarkup(resolved);
}
