/**
 * How the finder orders the artifacts behind Artifact Perks (owner 2026-11-09: grouped by owning
 * artifact, newest first). Names come from the manifest; this registry only orders them.
 *
 * Current artifacts (the rule, validated against the owner's list of 7 on manifest
 * 245114.26.10.13.2000-1-bnet.66137): inventory items whose type is "Artifact" and that have
 * sockets. Those are the socketed artifacts a player equips today; each socket's plug set holds
 * its 21 "Artifact Perk" plugs (plugCategoryIdentifier `artifact_perks`). The older, unsocketed
 * definitions (itemType 28 "Seasonal Artifact" and preview-only "Artifact" items) are past
 * seasons'. Keyed by the socketed artifact hash; the value is its DestinySeasonDefinition
 * seasonNumber. An artifact the registry does not know is listed first (a new season's artifact
 * is the newest), then by name.
 */
export const artifactSeasons: Readonly<Record<number, number>> = {
  1014202826: 28, // Encrypted Data Disk, Monument of Triumph
  23349941: 27, // Implement of Curiosity, Season: Reclamation
  3821685388: 26, // Tablet of Ruin, Episode: Heresy
  1770364095: 25, // Slayer Baron Apothecary Satchel, Episode: Revenant
  2180638678: 24, // Hunter's Journal, Episode: Echoes
  3518286241: 23, // Queensfoil Censer, Season of the Wish
  1504442987: 21, // NPA Repulsion Regulator, Season of the Deep
};

/** Perks that no current artifact socket offers (earlier artifact definitions) sort last. */
export const noArtifact = 'none';
export const noArtifactLabel = 'No current artifact';

/** Sort order of an artifact group: unknown (newest) first, then newest season first. */
export function artifactOrder(hash: number | undefined): number {
  if (hash === undefined) return 10_000;
  const season = artifactSeasons[hash];
  return season === undefined ? 0 : 1_000 - season;
}
