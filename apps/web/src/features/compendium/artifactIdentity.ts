import { compendiumTabId } from '@clarity/core';
import { normaliseCompendiumName, type CompendiumData } from '@clarity/core';
import { approvedAbsentArtifact } from './ownerExceptions';
import { loadManifestFacts } from './manifestFacts';
import type { ReviewSample } from './reviewCategories';

const facts = loadManifestFacts();

// The sheet's named artifact sections are its currently equippable artifact list.
export function artifactSections(source: CompendiumData) {
  return (source.tabs.find((tab) => tab.gid === compendiumTabId('Artifact Perks'))?.grid ?? [])
    .filter((cell) => cell.col === 3 && /\s\([^()]+\)\s*$/.test(cell.cell.plain))
    .sort((a, b) => a.row - b.row);
}
export function artifactParents(entry: ReviewSample) {
  return [
    ...new Set(
      (entry.manifestFacts?.item.artifactMemberships ?? [])
        .filter((membership) => membership.source === 'socket')
        .map((membership) => membership.artifactName)
        .filter((name): name is string => !!name),
    ),
  ];
}
export function sunsetArtifact(entry: ReviewSample, source: CompendiumData) {
  const parents = artifactParents(entry),
    sections = artifactSections(source);
  return (
    parents.length > 0 &&
    sections.length > 0 &&
    !parents.some((name) =>
      sections.some(
        (cell) => normaliseCompendiumName(cell.cell.plain) === normaliseCompendiumName(name),
      ),
    )
  );
}

export function currentArtifactOwners(hash: number, source?: CompendiumData | null) {
  const sections = source ? artifactSections(source) : [];
  return new Map(
    (facts.items[hash]?.artifactMemberships ?? [])
      .filter(
        (m) =>
          m.source === 'socket' &&
          sections.some(
            (s) =>
              normaliseCompendiumName(s.cell.plain) ===
              normaliseCompendiumName(m.artifactName ?? ''),
          ),
      )
      .map((m) => [m.artifactHash, m.artifactName!]),
  );
}
export function notCurrentArtifact(entry: ReviewSample, source: CompendiumData) {
  const sections = artifactSections(source);
  return (
    sunsetArtifact(entry, source) ||
    (sections.length > 0 &&
      artifactParents(entry).length === 0 &&
      approvedAbsentArtifact(entry) &&
      !source.tabs
        .find((t) => t.gid === compendiumTabId('Artifact Perks'))!
        .rows.some((row) => row.nameNorm === normaliseCompendiumName(entry.name)))
  );
}
