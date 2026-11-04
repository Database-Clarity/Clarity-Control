import { compendiumTabId, setBonusCell } from '@clarity/core';
import { type CompendiumData } from '@clarity/core';
import type { ReviewSample } from './reviewCategories';
import { confirmCompendiumSelection } from './selection';
import type { GuidedDecision } from './guidedDecisions';

export function inferredSetBonusDecision(
  entry: ReviewSample,
  source: CompendiumData,
): Partial<GuidedDecision> | undefined {
  if (entry.category !== 'armor-set-bonus') return;
  const metadata = entry.setBonus;
  const identity = /^(.*) \(([24]) pc\): (.+)$/.exec(entry.name);
  const setName = metadata?.setName.replace(/ Set$/, '');
  const heading = setName === 'Wayward Psyche' ? 'Uncaged Deviants' : setName;
  const matches =
    !metadata ||
    !identity ||
    identity[1] !== metadata.setName ||
    Number(identity[2]) !== metadata.pieceCount
      ? []
      : source.tabs
          .filter((tab) => tab.gid === compendiumTabId('Armor Perks'))
          .flatMap((tab) =>
            tab.rows.flatMap((row) => {
              if (
                row.section !== 'Armor Set Bonuses' ||
                row.name.split(/\r?\n/)[0].trim() !== heading
              )
                return [];
              const cell = setBonusCell(row.cell, metadata.pieceCount);
              if (
                !cell ||
                cell.plain.split(/\r?\n/)[0] !== `${metadata.pieceCount} Piece | ${identity[3]}`
              )
                return [];
              return [{ tab, row: { ...row, cell }, setBonusPieces: metadata.pieceCount }];
            }),
          );
  const link = matches.length === 1 && confirmCompendiumSelection(matches[0], source);
  return {
    action: link ? 'link' : 'owner',
    confidence: link ? 'high' : 'unresolved',
    ruleId: 'armor-set-perk-piece-count',
    link: link ? { ...link, snapshotAt: source.fetchedAt } : undefined,
    reason: link
      ? 'Exact set heading, perk name, and piece count; owner-approved Set suffix and Wayward Psyche alias.'
      : 'Set bonus identity or unique exact source is not established; verify manually.',
  };
}

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
