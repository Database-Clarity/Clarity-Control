import { normaliseCompendiumName, type CompendiumData } from '@clarity/core';
import type { ReviewSample } from './reviewCategories';

// The sheet's named artifact sections are its currently equippable artifact list.
export function artifactSections(source: CompendiumData) {
  return (source.tabs.find((tab) => tab.gid === '473308249')?.grid ?? [])
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
