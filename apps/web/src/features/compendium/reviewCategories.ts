import { classifyItem, type ItemClassification } from './itemClassification';
import { groupManifestItems } from './manifestItems';
import { incomingAliases, type CompendiumData } from '@clarity/core';
import { notCurrentArtifact } from './artifactIdentity';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import type { applyReviewProgress } from './reviewQueue';
import { sourceFingerprint } from './reviewProgress';
import { loadManifestFacts, type ManifestFacts } from './manifestFacts';

const catalogFacts = loadManifestFacts();

export type ReviewEntry = ReturnType<typeof applyReviewProgress>[number];
export type ReviewSample = ReviewEntry & {
  sampleEvidence: string;
  evidenceManifest?: unknown;
  /** Accepted alias-group members whose tooltip and catalog facts now live on this entry. */
  groupMembers?: number[];
  classification?: ItemClassification;
  exoticParentNames?: string[];
  scopeRestored?: boolean;
  setBonus?: { setName: string; pieceCount: 2 | 4 };
  artifactSunset?: boolean;
  manifestFacts?: { item: ManifestFacts['items'][string]; version: string };
  /** Keywords are trait definitions, so they do not have inventory manifest facts. */
  manifestKeywordDescription?: string;
};
export const reasonLabels = {
  validated: 'Validated proposals',
  fuzzy: 'Fuzzy candidates only',
  none: 'No resolver candidate',
  'missing-description': 'Missing manifest description',
  pending: 'Matching in progress',
  failed: 'Matching unavailable',
};
export type CategoryReason = keyof typeof reasonLabels;
export interface ReviewCategory {
  id: string;
  name: string;
  group: string;
  rule: string;
  entries: ReviewSample[];
  reasons: Record<CategoryReason, ReviewSample[]>;
  samples: ReviewSample[];
}

export function categoryId(category: string) {
  return `catalog:${encodeURIComponent(category)}`;
}

export function reviewCategories(
  entries: ReviewEntry[],
  editor: EditorData,
  proposals: Map<number, ReviewProposal>,
  matching: boolean,
  failed = false,
  source?: CompendiumData,
): ReviewCategory[] {
  const manifest = groupManifestItems(editor.items, editor.aliases);
  // Owner evidence records catalog identity, never an editor alias-group decision: grouping
  // accepted groups would otherwise rewrite every canonical's sample evidence and drop its
  // recorded owner sample (root brief MATCHER-EVIDENCE, 2026-11-19).
  const evidenceGroups = groupManifestItems(editor.items, editor.generatorAliases ?? editor.aliases);
  const facts = catalogFacts;
  const groups = new Map<string, ReviewCategory>();
  for (const entry of entries) {
    const id = categoryId(entry.category);
    const definition = editor.categories.find((category) => category.id === entry.category);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: definition?.label ?? `Other: ${entry.category}`,
        group: definition?.group ?? 'Other',
        rule: `Canonical review entries whose catalog categoryId is exactly ${JSON.stringify(entry.category)}. Includes unlinked/repair entries and local review history; healthy saved links without local history and sandbox/frame aliases are excluded. Matching reason is a subgroup, never category identity.`,
        entries: [],
        reasons: {
          validated: [],
          fuzzy: [],
          none: [],
          'missing-description': [],
          pending: [],
          failed: [],
        },
        samples: [],
      };
      groups.set(id, group);
    }
    const proposal = proposals.get(entry.hash);
    const reason: CategoryReason = !(manifest.get(entry.hash) ?? []).some((item) =>
      item.inGameDescription.trim(),
    )
      ? 'missing-description'
      : matching
        ? 'pending'
        : failed
          ? 'failed'
          : proposal?.link
            ? 'validated'
            : proposal?.candidates.length
              ? 'fuzzy'
              : 'none';
    const items = manifest.get(entry.hash) ?? [];
    const fact = facts.items[String(entry.hash)];
    // All aliases must describe the same raw inventory item before attaching facts.
    const agreed =
      fact?.inventory &&
      items.length > 0 &&
      items.every(
        (item) =>
          item.hash === entry.hash &&
          item.name === fact.inventory!.displayName &&
          (!item.inGameDescription.trim() ||
            item.inGameDescription === fact.inventory!.description),
      );
    const evidenceManifest = (evidenceGroups.get(entry.hash) ?? [])
      .map((item) => ({
        hash: item.hash,
        name: item.name,
        categoryId: item.categoryId,
        description: item.inGameDescription,
        baseHash: item.baseHash,
        owners: item.owners,
        ...(item.categoryId === 'armor-set-bonus'
          ? { setName: item.setName, pieceCount: item.pieceCount }
          : {}),
      }))
      .sort((a, b) => a.hash - b.hash);
    // Identity evidence is this entry's own item: members are duplicates, and grouping them in
    // or out must not rewrite an approval's fingerprint (root brief MATCHER-EVIDENCE-2,
    // 2026-11-19, porting the second run's self-identity rule).
    const ownManifest = evidenceManifest.filter((item) => item.hash === entry.hash);
    const keyword = editor.items[entry.hash];
    // Accepted name groups only: those members' tooltips and catalog facts live here now.
    const groupMembers = incomingAliases(entry.hash, editor.aliases)
      .filter(([, kind]) => kind === 'name')
      .map(([hash]) => hash);
    const sample: ReviewSample = {
      evidenceManifest,
      ...entry,
      ...(groupMembers.length ? { groupMembers } : {}),
      ...(items.length === 1 &&
      items[0].categoryId === 'armor-set-bonus' &&
      items[0].setName &&
      items[0].pieceCount
        ? { setBonus: { setName: items[0].setName, pieceCount: items[0].pieceCount } }
        : {}),
      classification:
        editor.items[entry.hash] &&
        classifyItem(editor.items[entry.hash], entry.next, editor.bundle.inactiveMoves),
      exoticParentNames: [
        ...new Set(
          items
            .flatMap((item) => [item.itemName, ...Object.values(item.ownerNames ?? {})])
            .filter((name): name is string => !!name),
        ),
      ],
      ...(agreed ? { manifestFacts: { item: fact, version: facts.source.manifestVersion } } : {}),
      ...(keyword?.categoryId === 'verbs' &&
      keyword.definitionType === 'DestinyTraitDefinition' &&
      keyword.inGameDescription.trim()
        ? { manifestKeywordDescription: keyword.inGameDescription }
        : {}),
      sampleEvidence: sourceFingerprint([
        entry.hash,
        entry.evidence,
        ...(entry.next.custom?.categoryId === 'attachment-effect'
          ? [entry.next.custom.categoryId]
          : []),
        ownManifest.length ? ownManifest : evidenceManifest,
      ]),
    };
    if (source && id === 'catalog:armor-mod-seasonal')
      sample.artifactSunset = notCurrentArtifact(sample, source);
    group.entries.push(sample);
    group.reasons[reason].push(sample);
  }
  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
    for (const entries of Object.values(group.reasons)) {
      entries.sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
    }
    const features = new Map(
      group.entries.map((entry) => {
        const items = manifest.get(entry.hash) ?? [];
        const description =
          items.find((item) => item.inGameDescription.trim())?.inGameDescription ??
          entry.base.text.en?.text ??
          '';
        const subtype = items.some((item) => (item.owners?.length ?? 0) > 1)
          ? 'shared'
          : items.some((item) => item.baseHash)
            ? 'enhanced'
            : items.length > 1
              ? 'aliased'
              : entry.base.custom
                ? 'custom'
                : 'single';
        const pattern = !description.trim()
          ? 'missing'
          : description.includes('\n')
            ? 'multiline'
            : /\b(after|while|when|if|on)\b/i.test(description)
              ? 'conditional'
              : /\d/.test(description)
                ? 'numeric'
                : description.length > 160
                  ? 'long'
                  : 'short';
        const reason = Object.entries(group.reasons).find(([, entries]) =>
          entries.some((candidate) => candidate.hash === entry.hash),
        )?.[0];
        const proposal = proposals.get(entry.hash);
        const match = proposal?.match ?? proposal?.candidates[0];
        return [
          entry.hash,
          [
            `reason:${reason}`,
            `subtype:${subtype}`,
            `pattern:${pattern}`,
            `source:${match?.tab.gid ?? ''}:${match?.row.section ?? ''}`,
          ],
        ] as const;
      }),
    );
    const covered = new Set<string>();
    const samples: ReviewSample[] = [];
    // Greedy coverage prioritizes resolver states, then available catalog structure and text patterns.
    while (samples.length < Math.min(5, group.entries.length)) {
      const remaining = group.entries.filter(
        (entry) => !samples.some((sample) => sample.hash === entry.hash),
      );
      const score = (entry: ReviewSample) =>
        features
          .get(entry.hash)!
          .reduce(
            (sum, feature, index) => sum + (covered.has(feature) ? 0 : [100, 20, 10, 5][index]),
            0,
          );
      remaining.sort((a, b) => score(b) - score(a) || a.hash - b.hash);
      const entry = remaining[0];
      samples.push(entry);
      for (const feature of features.get(entry.hash)!) covered.add(feature);
    }
    group.samples = samples;
  }
  return [...groups.values()].sort((a, b) => {
    const order = (id: string) =>
      editor.categories.find((category) => categoryId(category.id) === id)?.order ?? 9999;
    return order(a.id) - order(b.id) || a.id.localeCompare(b.id);
  });
}
