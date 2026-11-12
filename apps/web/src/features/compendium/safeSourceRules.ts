import {
  compendiumIdentifiers,
  compendiumTabId,
  normaliseCompendiumName,
  setBonusCell,
} from '@clarity/core';
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

// Exotic Class Item perks are shared by all three class items (owner 2026-11-12: their
// own category). The perk name is the identity: one exact row in the Exotic Class tab.
// Root ruling 2026-11-12: the sheet's optional "the" in "Spirit of the X" also links, only
// when that stem is unique in the tab and no other class item perk shares it.
const spiritStem = (name: string) =>
  /^Spirit of /i.test(name)
    ? normaliseCompendiumName(name.replace(/^Spirit of (?:the )?/i, ''))
    : undefined;
export function inferredClassItemPerkDecision(
  entry: ReviewSample,
  source: CompendiumData,
  // Names of the other class item perks in the category; a shared stem keeps a proposal.
  others: readonly string[] = [],
): Partial<GuidedDecision> | undefined {
  if (entry.category !== 'armor-trait-exotic-class-item') return;
  const gid = compendiumTabId('Exotic Class');
  const rows = source.tabs
    .filter((tab) => tab.gid === gid)
    .flatMap((tab) => tab.rows.map((row) => ({ tab, row })));
  const name = normaliseCompendiumName(entry.name);
  const exact = rows.filter(({ row }) =>
    compendiumIdentifiers(row.name).some(
      (identifier) => normaliseCompendiumName(identifier) === name,
    ),
  );
  const stem = spiritStem(entry.name);
  const article = exact.length
    ? []
    : rows.filter(
        ({ row }) =>
          stem !== undefined &&
          compendiumIdentifiers(row.name).some((identifier) => spiritStem(identifier) === stem),
      );
  const matches = exact.length ? exact : article;
  const link = matches.length === 1 && confirmCompendiumSelection(matches[0], source);
  if (!link || link.parts)
    return {
      action: 'owner',
      confidence: 'unresolved',
      ruleId: 'exotic-class-item-perk',
      reason: `Class item perk: ${matches.length > 1 ? `${matches.length} Exotic Class rows share this name` : matches.length ? 'source cell does not resolve uniquely' : 'no Exotic Class row has this name'}; pick the source manually.`,
    };
  const row = matches[0].row;
  return exact.length
    ? {
        action: 'link',
        confidence: 'high',
        ruleId: 'exotic-class-item-perk',
        link: { ...link, snapshotAt: source.fetchedAt },
        reason: `Exact unique perk name in Exotic Class, ${row.section ?? 'row'} ${row.rowIndex}.`,
      }
    : others.some((other) => spiritStem(other) === stem)
      ? {
          action: 'link',
          confidence: 'medium',
          ruleId: 'exotic-class-item-article',
          link: { ...link, snapshotAt: source.fetchedAt },
          reason: `Sheet name "${row.name}" differs only by "the", but another class item perk shares the stem. Confirm the source.`,
        }
      : {
          action: 'link',
          confidence: 'high',
          ruleId: 'exotic-class-item-article',
          link: { ...link, snapshotAt: source.fetchedAt },
          reason: `Sheet name "${row.name}" differs only by "the"; stem unique in Exotic Class and among class item perks.`,
        };
}
