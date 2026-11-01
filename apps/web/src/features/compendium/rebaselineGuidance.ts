import type { CompendiumData } from '@clarity/core';
import { guidanceSchema, type GuidanceDocument } from './guidanceSchema';
import type { ReviewCategory } from './reviewCategories';
import { referenceCurrent } from './sampleReferences';

// Renew commit-only changes. Evidence includes editor English/link, catalog identity,
// grouped manifest descriptions and the source-tab fingerprint. Never rewrite evidence.
export function rebaselineGuidance(
  input: GuidanceDocument,
  categories: ReviewCategory[],
  source: CompendiumData,
  baseline: string,
  scope: string,
) {
  const document = guidanceSchema.parse(structuredClone(input));
  if (document.scope !== scope) throw new Error('Cannot renew guidance from another dataset.');
  const renewed: number[] = [];
  const changed: { hash: number; categoryId: string; name: string; reason: string }[] = [];
  const current = new Map(categories.map((category) => [category.id, category]));
  for (const record of Object.values(document.categories)) {
    const entries = new Map(current.get(record.id)?.entries.map((entry) => [entry.hash, entry]));
    for (const reference of Object.values(record.references ?? {})) {
      const entry = entries.get(reference.hash);
      // The old baseline is deliberately used only for this comparison. Every other
      // validity condition (including the selected source cells) remains mandatory.
      if (
        record.hashes.includes(reference.hash) &&
        entry &&
        referenceCurrent(reference, entry, reference.baseline, source)
      ) {
        reference.baseline = baseline;
        renewed.push(reference.hash);
      } else {
        changed.push({
          hash: reference.hash,
          categoryId: record.id,
          name: reference.name,
          reason:
            'Entry missing, outside recorded membership, or editor/catalog/source evidence changed.',
        });
      }
    }
  }
  document.baseline = baseline;
  return { document, renewed, changed };
}
