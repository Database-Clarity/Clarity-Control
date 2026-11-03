import { stableStringify } from './contentHash.js';
import { usesEnglishFallback } from './exportLegacy.js';
import { tooltipSchema, type Tooltip } from './schemas.js';

/**
 * Digest of what a push would publish: the text each language is exported with (so a stale
 * translation that falls back to English hashes as the English text), which languages fall back
 * (so a fallback flip invalidates a review even if the words happen to match), associations and
 * the custom definition. Tooltips with no fallback hash exactly as before the fallback was added.
 */
export async function publishableHash(tooltip: Tooltip): Promise<string> {
  const parsed = tooltipSchema.parse(tooltip);
  const english = parsed.text.en;
  const fallback = Object.keys(parsed.text).filter((language) =>
    usesEnglishFallback(parsed, language as keyof Tooltip['text']),
  );
  const bytes = new TextEncoder().encode(
    stableStringify({
      text: Object.fromEntries(
        Object.entries(parsed.text).map(([language, value]) => [
          language,
          fallback.includes(language) && english ? english.text : value.text,
        ]),
      ),
      associated: parsed.associated,
      custom: parsed.custom,
      ...(fallback.length ? { fallback: fallback.sort() } : {}),
    }),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
