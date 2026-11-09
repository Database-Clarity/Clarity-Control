/**
 * How the finder names and orders the activities behind Activity Mods (owner-approved 2026-11-09; Crota's End and Salvation's Edge
 * added 2026-11-09).
 * Keyed by the manifest plug category (`plugCategoryIdentifier`, written `enhancements.<key>` in
 * the manifest; the prefix is ignored), never by item names. Presentation only: category ids,
 * generator data, and export are unchanged.
 */
export interface ActivitySpec {
  label: string;
  order: number;
}

export const activitySpecs: Readonly<Record<string, ActivitySpec>> = {
  season_outlaw: { label: 'Last Wish', order: 1 },
  raid_garden: { label: 'Garden of Salvation', order: 2 },
  raid_descent: { label: 'Deep Stone Crypt', order: 3 },
  raid_v520: { label: 'Vault of Glass', order: 4 },
  raid_v600: { label: 'Vow of the Disciple', order: 5 },
  raid_v620: { label: "King's Fall", order: 6 },
  raid_v700: { label: 'Root of Nightmares', order: 7 },
  raid_v720: { label: "Crota's End", order: 8 },
  raid_v800: { label: "Salvation's Edge", order: 9 },
  season_maverick: { label: 'Nightmares (Shadowkeep)', order: 10 },
};

/** Activities the registry does not know sort after the named ones, then by label. */
export const unknownActivityOrder = 1000;
export const missingActivity = 'unknown';

/**
 * The activity group of a plug category. An unregistered plug takes the quoted name in the
 * manifest description when it has one, else a visible "Other: <plug>"; a missing plug is
 * "Unknown activity". Never a silent label.
 */
export function activityDisplay(plug: string | undefined, description?: string): ActivitySpec {
  if (!plug) return { label: 'Unknown activity', order: unknownActivityOrder + 1 };
  const known = activitySpecs[plug.replace(/^enhancements\./, '')];
  if (known) return known;
  const quoted = description && /"([^"]+)"/.exec(description)?.[1];
  return { label: quoted || `Other: ${plug}`, order: unknownActivityOrder };
}
