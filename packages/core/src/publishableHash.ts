import { incomingAliases, type Aliases } from './aliases.js';
import { stableStringify } from './contentHash.js';
import { usesEnglishFallback } from './exportLegacy.js';
import { lowerConsumerMarkup } from './markup/braces.js';
import { tooltipSchema, type Tooltip } from './schemas.js';

/**
 * Digest of what a push would publish: the text each language is exported with (so a stale
 * translation that falls back to English hashes as the English text), which languages fall back
 * (so a fallback flip invalidates a review even if the words happen to match), associations and
 * the custom definition. When `aliases` are given, the aliases that resolve to this tooltip are
 * included too (a push also writes their stubs). Tooltips with neither a fallback nor aliases hash
 * exactly as before.
 *
 * Text is hashed in the form every exporter reads (lowerConsumerMarkup: element tags and the
 * delimited forms lowered), so a spelling-only change such as `#e` -> `<enhanced/>`, `#d` ->
 * `#{d}`, or `<solar/>Scorch` -> `<solar Scorch />` is not a pending change, while any edit that
 * changes exported bytes is. On text without element tags, `#{name}`, or `<enhanced/>` that form is
 * the text itself, so every digest recorded before those forms existed still matches.
 */
export async function publishableHash(tooltip: Tooltip, aliases: Aliases = {}): Promise<string> {
  const parsed = tooltipSchema.parse(tooltip);
  const english = parsed.text.en;
  const incoming = incomingAliases(parsed.hash, aliases);
  const fallback = Object.keys(parsed.text).filter((language) =>
    usesEnglishFallback(parsed, language as keyof Tooltip['text']),
  );
  const bytes = new TextEncoder().encode(
    stableStringify({
      text: Object.fromEntries(
        Object.entries(parsed.text).map(([language, value]) => [
          language,
          lowerConsumerMarkup(fallback.includes(language) && english ? english.text : value.text),
        ]),
      ),
      associated: parsed.associated,
      custom: parsed.custom,
      ...(fallback.length ? { fallback: fallback.sort() } : {}),
      ...(incoming.length ? { aliases: incoming } : {}),
    }),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The digest as computed before the fallback and alias inputs existed: raw per-language text,
 * associations and custom facts. Only for recognising markers recorded back then (history lookup);
 * never for pending status or review checks, which must see fallback and alias changes.
 */
export async function legacyPublishableHash(tooltip: Tooltip): Promise<string> {
  const parsed = tooltipSchema.parse(tooltip);
  const bytes = new TextEncoder().encode(
    stableStringify({
      text: Object.fromEntries(
        Object.entries(parsed.text).map(([language, value]) => [language, value.text]),
      ),
      associated: parsed.associated,
      custom: parsed.custom,
    }),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
