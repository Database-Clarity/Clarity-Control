import { compendiumTabId } from '@clarity/core';
import { type CompendiumData } from '@clarity/core';
import type { ReviewSample } from './reviewCategories';
import { confirmCompendiumSelection } from './selection';
import type { GuidedDecision } from './guidedDecisions';

// Element/damage-family labels are supported only on actual helmet mod plugs.
// Artifact "Elemental Siphon" is a different family and cannot enter this path.
export function inferredSiphonDecision(
  entry: ReviewSample,
  source: CompendiumData,
): Partial<GuidedDecision> | undefined {
  if (
    entry.category !== 'armor-mod-general' ||
    entry.manifestFacts?.item.inventory?.plug?.plugCategoryIdentifier !== 'enhancements.v2_head' ||
    entry.manifestFacts.item.inventory.displayName !== entry.name ||
    !/^(?:(?:Kinetic|Harmonic|Arc|Solar|Void|Stasis|Strand) Siphon|(?:Arc|Solar|Void|Stasis|Strand)\/(?:Arc|Solar|Void|Stasis|Strand) (?:Dual Siphon|Siphon Combo)|Kinetic (?:Charge|Entropy|Thermal) Siphon)$/.test(
      entry.name,
    )
  )
    return;
  const matches = source.tabs
    .filter((tab) => tab.gid === compendiumTabId('Armor Mods'))
    .flatMap((tab) =>
      tab.rows
        .filter((row) => row.section === 'Helmet' && row.nameNorm === 'siphon')
        .map((row) => ({ tab, row })),
    );
  const match = matches[0];
  const link =
    matches.length === 1 &&
    /Orbs? of Power/i.test(match.row.cell.plain) &&
    /Weapon/i.test(match.row.cell.plain) &&
    confirmCompendiumSelection(match, source);
  return link
    ? {
        action: 'link',
        confidence: 'high',
        ruleId: 'armor-siphon-family',
        link: { ...link, snapshotAt: source.fetchedAt },
        reason:
          'Helmet plug and approved damage-family Siphon semantics resolve to the unique generic Helmet Siphon source.',
      }
    : {
        action: 'owner',
        confidence: 'unresolved',
        ruleId: 'armor-siphon-family',
        reason: `Siphon family recognized, but the generic Helmet source is ${matches.length === 0 ? 'missing' : matches.length > 1 ? 'ambiguous' : 'not a verified weapon/Orb description'}.`,
      };
}
