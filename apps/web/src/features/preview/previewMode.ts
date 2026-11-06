/** The preview column's views: Base and Enhanced are what a consumer sees, Compare is a working view. */
export type PreviewMode = 'base' | 'enhanced' | 'compare';

/** Compare on a desktop (it shows both at once), Enhanced on a phone (one narrow column). */
export function defaultMode(phone: boolean): PreviewMode {
  return phone ? 'enhanced' : 'compare';
}

/** The view in effect: items without an enhanced version only have their base. */
export function effectiveMode(
  chosen: PreviewMode | null,
  phone: boolean,
  hasEnhanced: boolean,
): PreviewMode {
  return hasEnhanced ? (chosen ?? defaultMode(phone)) : 'base';
}

/**
 * The variants whose current text a visible preview shows, i.e. what counts as previewed in any
 * view. A derived Enhanced is the base text read as the enhanced type, an override is its own text.
 * Compare lays the selected enhanced version over the base, so it shows both: an edit to either is
 * in front of the reader (a derived Enhanced has no text of its own, so Compare shows the base).
 */
export function previewedHashes(
  mode: PreviewMode,
  base: number,
  enhanced: { hash: number; derived: boolean } | undefined,
): number[] {
  if (mode === 'base') return [base];
  if (!enhanced) return mode === 'compare' ? [base] : [];
  const own = enhanced.derived ? base : enhanced.hash;
  return mode === 'enhanced' ? [own] : [...new Set([base, own])];
}
