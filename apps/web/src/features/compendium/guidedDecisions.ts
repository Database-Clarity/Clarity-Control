import { normaliseCompendiumName, type CompendiumData, type CompendiumLink } from '@clarity/core';
import { compendiumSimilarity } from '@clarity/core';
import { confirmCompendiumSelection } from './selection';
import type { GuidanceDocument, GuidanceReference } from './guidanceSchema';
import type { ReviewCategory, ReviewSample } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import { referenceCurrent } from './sampleReferences';
import { sourceFingerprint } from './reviewProgress';
import { manifestRule } from './manifestRule';
import { classifyScope } from './reviewScope';

export interface GuidedDecision {
  hash: number;
  name: string;
  categoryId: string;
  confidence: 'high' | 'medium' | 'unresolved' | 'out-of-scope';
  ruleId: string;
  action: 'link' | 'no-equivalent' | 'owner' | 'preserve' | 'out-of-scope';
  reason: string;
  references: number[];
  evidence?: string;
  link?: CompendiumLink;
}
export interface GuidedCategory {
  id: string;
  name: string;
  comment: string;
  pattern: string;
  issues: string[];
  entries: GuidedDecision[];
  high: number;
  unresolved: number;
  outOfScope: number;
  medium: number;
  ownerNote: string;
  samples: number[];
  referenceEvidence: GuidanceReference[];
}

function stableSelection(
  match: Parameters<typeof confirmCompendiumSelection>[0],
  source: CompendiumData,
) {
  const link = confirmCompendiumSelection(match, source);
  return link && { ...link, snapshotAt: source.fetchedAt };
}

// Bounded typo comparison on normalized full names. A close runner-up is ambiguous.
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

// Pure planning only. No drafts, progress, guidance writes, authentication or save calls.
export function guidedDecisions(
  document: GuidanceDocument,
  categories: ReviewCategory[],
  proposals: Map<number, ReviewProposal>,
  source: CompendiumData,
  baseline: string,
  scope: string,
): GuidedCategory[] {
  const current = new Map(categories.map((category) => [category.id, category]));
  const globalUsable = new Map<number, GuidanceReference>();
  if (document.scope === scope && document.baseline === baseline) {
    for (const record of Object.values(document.categories)) {
      if (!record.active) continue;
      const category = current.get(record.id);
      for (const ref of Object.values(record.references ?? {})) {
        const entry = category?.entries.find((candidate) => candidate.hash === ref.hash);
        if (
          entry &&
          record.hashes.includes(ref.hash) &&
          ref.decision === 'no-equivalent' &&
          referenceCurrent(ref, entry, baseline, source)
        )
          globalUsable.set(ref.hash, ref);
      }
    }
  }
  return Object.values(document.categories)
    .filter((record) => record.active)
    .map((record) => {
      const category = current.get(record.id);
      const entries = new Map(category?.entries.map((entry) => [entry.hash, entry]));
      const issues: string[] = [];
      const compatible = document.scope === scope && document.baseline === baseline;
      if (document.scope !== scope) issues.push('Dataset scope differs; all proposals withheld.');
      if (document.baseline !== baseline)
        issues.push('Baseline differs; renew references before proposing.');
      if (!category) issues.push('Recorded category is absent from the current review queue.');
      const references = Object.values(record.references ?? {});
      const usable = new Map<number, GuidanceReference>();
      for (const reference of references) {
        const entry = entries.get(reference.hash);
        if (
          !record.hashes.includes(reference.hash) ||
          !entry ||
          !compatible ||
          !referenceCurrent(reference, entry, baseline, source)
        ) {
          issues.push(
            `Reference ${reference.hash}: stale, missing or outside recorded membership.`,
          );
        } else if (reference.decision && reference.decision !== 'skipped') {
          usable.set(reference.hash, reference);
        }
      }
      const extra = category?.entries.filter((entry) => !record.hashes.includes(entry.hash)) ?? [];
      if (extra.length) issues.push(`${extra.length} new entries excluded from recorded scope.`);
      const decide = (hash: number): GuidedDecision => {
        const entry: ReviewSample | undefined = entries.get(hash);
        const result: GuidedDecision = {
          hash,
          name: entry?.name ?? references.find((ref) => ref.hash === hash)?.name ?? String(hash),
          categoryId: record.id,
          action: 'owner',
          confidence: 'unresolved',
          references: [],
          evidence: entry?.sampleEvidence,
          ruleId: 'owner-no-candidate',
          reason: 'No supported mapping; owner decision needed.',
        };
        if (!entry)
          return { ...result, reason: 'Recorded entry is missing or no longer in this category.' };
        if (entry.base.compendium || entry.next.compendium || entry.status !== 'open')
          return {
            ...result,
            action: 'preserve',
            reason: 'Existing link, draft or human review decision preserved.',
          };
        if (!compatible)
          return { ...result, reason: 'Scope or baseline differs; proposal withheld.' };
        const scopeRule = classifyScope(entry, record.id);
        if (scopeRule)
          return {
            ...result,
            action: 'out-of-scope',
            confidence: 'out-of-scope',
            ruleId: scopeRule,
            reason: `Out of scope: ${scopeRule}.`,
          };
        const reference = usable.get(hash);
        if (reference)
          return {
            ...result,
            action: reference.link ? 'link' : 'no-equivalent',
            confidence: 'high',
            ruleId: 'explicit-owner',
            link: reference.link,
            references: [hash],
            reason: 'Current explicit owner reference; applies to this entry only.',
          };
        // Never override an unresolved/stale/skipped/note-only owner sample with an inferred rule.
        if (record.references?.[hash])
          return { ...result, reason: 'Owner sample unresolved or stale; not inferred.' };
        if (record.comment.trim())
          return {
            ...result,
            reason: 'Category comment needs agent interpretation; no automatic rule applied.',
          };
        const manifestDecision = manifestRule(entry, record.id, globalUsable);
        if (manifestDecision) return { ...result, ...manifestDecision };
        if (record.id === 'catalog:armor-mod-seasonal')
          return {
            ...result,
            ruleId: 'owner-artifact-identity',
            reason:
              'Current artifact identity is not established by a name or learned tab. Select a current-artifact source explicitly. Anchors: ' +
              source.tabs
                .filter((tab) => tab.name === 'Artifact Perks')
                .flatMap((tab) =>
                  tab.rows
                    .filter((row) => row.nameNorm === normaliseCompendiumName(entry.name))
                    .map((row) =>
                      JSON.stringify({
                        gid: tab.gid,
                        section: row.section,
                        row: row.rowIndex,
                        anchor: row.anchor,
                      }),
                    ),
                )
                .join('; '),
          };
        // Learn the tab from every current positive sample, including picked renames.
        // Section labels are layout headings, not category boundaries (e.g. Armor Mods slots).
        const positive = [...usable.values()].filter((ref) => ref.link);
        const tabs = new Set(positive.map((ref) => ref.link!.gid));
        const support = positive.map((ref) => ref.hash);
        const norm = normaliseCompendiumName(entry.name);
        const names = new Set([norm]);
        const fragment = /^(?:Facet|Whisper|Ember|Spark|Echo|Thread) of (.+)$/i.exec(entry.name);
        if (fragment) names.add(normaliseCompendiumName(fragment[1]));
        // Owner explicitly approves shared finder and surge rows. No generic prefix stripping.
        const shared =
          record.id === 'catalog:armor-mod-general'
            ? entry.name
                .replace(/^(?:Heavy|Special) Ammo Finder$/, 'Ammo Finder')
                .replace(/^(?:Kinetic|Arc|Solar|Void|Stasis|Strand) Weapon Surge$/, 'Weapon Surge')
            : entry.name;
        names.add(normaliseCompendiumName(shared));
        const catalyst =
          record.id === 'catalog:weapon-catalyst-exotic'
            ? entry.name.replace(/ Catalyst$/, '')
            : entry.name;
        const candidates = source.tabs
          .filter((tab) => tabs.has(tab.gid))
          .flatMap((tab) =>
            tab.rows.map((row) => {
              const first = normaliseCompendiumName(row.name.split(/\r?\n/)[0]);
              const lines = row.name
                .split(/\r?\n/)
                .map((line) => normaliseCompendiumName(line.replace(/^↑/, '')));
              const exact = names.has(normaliseCompendiumName(row.name)) || names.has(first);
              const token = lines.includes(norm) || first === normaliseCompendiumName(catalyst);
              return {
                tab,
                row,
                exact,
                token,
                distance: editDistance(norm, first),
                score: Math.max(...[...names].map((name) => compendiumSimilarity(name, first))),
              };
            }),
          );
        const exact = candidates.filter((candidate) => candidate.exact);
        const token = candidates.filter((candidate) => candidate.token);
        const ranked = [...candidates].sort((a, b) => b.score - a.score);
        const typoRanked = [...candidates].sort((a, b) => a.distance - b.distance);
        const typo =
          norm.length >= 8 &&
          typoRanked[0]?.distance <= 2 &&
          (typoRanked[1]?.distance ?? Infinity) - typoRanked[0].distance >= 2
            ? typoRanked[0]
            : undefined;
        const best =
          exact.length === 1
            ? exact[0]
            : exact.length
              ? undefined
              : token.length === 1
                ? token[0]
                : token.length
                  ? undefined
                  : ranked[0]?.score >= 0.65 && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.08
                    ? ranked[0]
                    : typo;
        if (!best) {
          const proposal = proposals.get(hash);
          if (exact.length > 1 || proposal?.match?.parts) {
            // Resolver agreement is not independent card/column or artifact evidence.
            // Keep all original source rows available for an explicit owner selection;
            // never expose the resolver's potentially duplicated/neighbor-labelled snapshot.
            return {
              ...result,
              ruleId: 'owner-multipart-source',
              references: support,
              reason:
                'Multiple same-name source rows require card/column and artifact identity review. ' +
                'No combined snapshot proposed. Anchors: ' +
                exact
                  .map(({ tab, row }) =>
                    JSON.stringify({
                      gid: tab.gid,
                      section: row.section,
                      row: row.rowIndex,
                      anchor: row.anchor,
                    }),
                  )
                  .join('; '),
            };
          }
          // An uncovered elemental tab is a review candidate, never inferred high.
          if (record.id.startsWith('catalog:subclass-') || record.id === 'catalog:verbs') {
            const outside = source.tabs
              .filter((tab) => !tabs.has(tab.gid))
              .flatMap((tab) =>
                tab.rows
                  .filter((row) => names.has(normaliseCompendiumName(row.name)))
                  .map((row) => ({ tab, row })),
              );
            if (outside.length === 1) {
              const link = stableSelection(outside[0], source);
              if (link)
                return {
                  ...result,
                  action: 'link',
                  confidence: 'medium',
                  link,
                  ruleId: 'uncovered-element-tab',
                  references: support,
                  reason: `Unique exact name in uncovered tab ${outside[0].tab.name}, row ${outside[0].row.rowIndex}; confirm tab convention.`,
                };
            }
          }
        }
        if (!best)
          return {
            ...result,
            reason: candidates.length
              ? 'No unique name/token hit or separated fuzzy candidate in learned tabs.'
              : 'No positive owner sample establishes a source tab.',
          };
        const link = stableSelection(best, source);
        if (!link)
          return {
            ...result,
            reason: 'Candidate cannot resolve uniquely to current source cells.',
          };
        if (link.parts)
          return {
            ...result,
            ruleId: 'owner-multipart-source',
            reason:
              'Combined source requires independent card/column validation; no combined snapshot proposed.',
          };
        // A note on a picked example supports its tab, not a generic rename rule.
        const high =
          exact.length === 1 &&
          !positive.some((ref) => ref.link?.gid === best.tab.gid && ref.link.cells);
        const ruleId =
          exact.length === 1
            ? fragment
              ? 'fragment-short-name'
              : shared !== entry.name
                ? 'owner-shared-armor-family'
                : 'unique-name-in-learned-tab'
            : token.length === 1
              ? 'exotic-name-line-or-catalyst'
              : best === typo &&
                  !(ranked[0]?.score >= 0.65 && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.08)
                ? 'separated-typo-name'
                : 'separated-fuzzy-name';
        return {
          ...result,
          confidence: high ? 'high' : 'medium',
          action: 'link',
          link,
          ruleId,
          references: support,
          reason:
            `${ruleId}: unique candidate in learned tab ${best.tab.name}; row ${best.row.rowIndex}; ` +
            `anchor ${JSON.stringify(best.row.anchor ?? null)}; score ${best.score.toFixed(3)}. ` +
            (high
              ? 'Normalized full/first-line name; current resolver confirmed description.'
              : 'Confirm source description; token/rename or selected-cell convention needs review.'),
        };
      };
      const decisions = record.hashes.map(decide);
      const medium = decisions.filter((entry) => entry.confidence === 'medium').length;
      const high = decisions.filter((entry) => entry.confidence === 'high').length;
      const outOfScope = decisions.filter((entry) => entry.confidence === 'out-of-scope').length;
      // Deterministic stratification by outcome, with remaining exceptions available in full below.
      const stratum = (entry: GuidedDecision) =>
        `${entry.ruleId}:${entry.confidence}:${entry.action}`;
      const samples = [...new Set(decisions.map(stratum))]
        .flatMap((kind) => decisions.filter((entry) => stratum(entry) === kind).slice(0, 2))
        .map((entry) => entry.hash);
      return {
        id: record.id,
        name: category?.name ?? record.name,
        comment: record.comment,
        pattern:
          'Unique normalized name in an owner-demonstrated tab; fragment prefixes and explicitly approved shared armor families normalized. Exotic name lines, catalyst suffixes and separated fuzzy names require confirmation. No-equivalent families require current owner support and explicit manifest predicates; missing names never prove exclusion.',
        issues,
        entries: decisions,
        high,
        medium,
        outOfScope,
        unresolved: decisions.length - high - medium - outOfScope,
        ownerNote: decisions.some((entry) => entry.confidence === 'unresolved')
          ? `Provide a source row or confirm no equivalent for representative exceptions: ${decisions
              .filter((entry) => entry.confidence === 'unresolved')
              .slice(0, 3)
              .map((entry) => entry.name)
              .join(
                ', ',
              )}. Notes/skips need an explicit decision; do not resolve the whole category from absence alone.`
          : 'No owner exceptions; confirm medium source descriptions individually.',
        samples,
        referenceEvidence: references,
      };
    });
}

export function guidedRevision(groups: GuidedCategory[]) {
  return sourceFingerprint(groups);
}
