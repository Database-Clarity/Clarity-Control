// The currently available artifacts and their perks, derived from the Destiny manifest (owner
// 2026-11-09). Rule: an inventory item typed "Artifact" that has sockets is a current, equippable
// artifact; its perks are the "Artifact Perk" plugs (plugCategoryIdentifier artifact_perks) that
// its sockets offer. Earlier artifacts survive only as unsocketed definitions (itemType 28
// "Seasonal Artifact", or preview-only "Artifact" items), so they never match. Validated against
// the owner's list of 7 on manifest 245114.26.10.13.2000-1-bnet.66137. The generator port of
// this rule is named in .agents/reports/artifact-groups.md.
//
// Usage: node scripts/compendium-guidance/current-artifacts.mjs   (downloads the live manifest)
import { fileURLToPath } from 'node:url';

const base = 'https://www.bungie.net';

function socketPlugs(entry, plugSets) {
  return [
    entry.singleInitialItemHash,
    ...(entry.reusablePlugItems ?? []).map((plug) => plug.plugItemHash),
    ...['reusablePlugSetHash', 'randomizedPlugSetHash'].flatMap((key) =>
      (plugSets[entry[key]]?.reusablePlugItems ?? []).map((plug) => plug.plugItemHash),
    ),
  ].filter(Boolean);
}

export function isArtifactPerk(definition) {
  return (
    definition?.plug?.plugCategoryIdentifier === 'artifact_perks' &&
    definition.itemTypeDisplayName === 'Artifact Perk'
  );
}

/** Current artifacts, newest season first: { hash, name, seasonHash, perks: [{ hash, name }] }. */
export function currentArtifacts(inventory, plugSets, seasons = {}) {
  return Object.values(inventory)
    .filter(
      (item) => item.itemTypeDisplayName === 'Artifact' && item.sockets?.socketEntries?.length,
    )
    .map((item) => {
      const perks = new Map();
      for (const entry of item.sockets.socketEntries)
        for (const hash of socketPlugs(entry, plugSets))
          if (isArtifactPerk(inventory[hash]))
            perks.set(hash, { hash, name: inventory[hash].displayProperties?.name ?? '' });
      return {
        hash: item.hash,
        name: item.displayProperties?.name ?? '',
        seasonHash: item.seasonHash ?? null,
        seasonNumber: seasons[item.seasonHash]?.seasonNumber ?? null,
        perks: [...perks.values()],
      };
    })
    .filter((artifact) => artifact.perks.length)
    .sort((a, b) => (b.seasonNumber ?? 0) - (a.seasonNumber ?? 0) || a.hash - b.hash);
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  const manifest = (await get(`${base}/Platform/Destiny2/Manifest/`)).Response;
  const paths = manifest.jsonWorldComponentContentPaths.en;
  const [inventory, plugSets, seasons] = await Promise.all(
    ['DestinyInventoryItemDefinition', 'DestinyPlugSetDefinition', 'DestinySeasonDefinition'].map(
      (type) => get(new URL(paths[type], base).href),
    ),
  );
  const artifacts = currentArtifacts(inventory, plugSets, seasons);
  console.log(`Manifest ${manifest.version}: ${artifacts.length} current artifacts`);
  for (const artifact of artifacts)
    console.log(
      `${artifact.hash} ${artifact.name} (season ${artifact.seasonNumber}): ${artifact.perks.length} perks`,
    );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
