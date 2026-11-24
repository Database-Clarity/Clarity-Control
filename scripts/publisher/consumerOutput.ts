import { enhancedArrowMarkup, findElementTags } from '../../packages/core/src/index.js';

/** Reject authored tokens the legacy consumer cannot render. */
export function unloweredEntry(entries: Record<string, unknown>): string | undefined {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  const unlowered = (text: string) =>
    /[\uE000\uE001]/.test(text) ||
    findElementTags(text).length > 0 ||
    text.includes('#{') ||
    text.includes(enhancedArrowMarkup);
  for (const [hash, entry] of Object.entries(entries))
    if (strings(entry).some(unlowered)) return hash;
  return undefined;
}
