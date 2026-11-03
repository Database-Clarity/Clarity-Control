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
 * The variants whose current text a visible preview has rendered, i.e. what counts as previewed.
 * A derived Enhanced is the base text read as the enhanced type, an override is its own text.
 * Compare is never a render a consumer sees, so it acknowledges nothing.
 */
export function previewedHashes(
  mode: PreviewMode,
  base: number,
  enhanced: { hash: number; derived: boolean } | undefined,
): number[] {
  if (mode === 'base') return [base];
  if (mode === 'enhanced' && enhanced) return [enhanced.derived ? base : enhanced.hash];
  return [];
}
