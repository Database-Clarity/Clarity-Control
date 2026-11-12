// Exotic armour piece icons for the finder's Exotic Armor list: every exotic armour definition's
// icon, keyed by item hash, from the same pinned DestinyInventoryItemDefinition component as
// exotic-weapon-icons.mjs (same URL, same sha256). The generator does not emit owner icons yet;
// once it does, this file and its script can go.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadPinnedInventory } from './exotic-weapon-icons.mjs';

const outUrl = new URL(
  '../../apps/web/src/features/navigation/exotic-armor-icons.json',
  import.meta.url,
);

/** Exotic armour (item type 2, tier 6) with an icon: hash -> icon file name under `prefix`. */
export function extract(inventory, prefix) {
  const icons = {};
  for (const [hash, item] of Object.entries(inventory)) {
    const icon = item?.displayProperties?.icon;
    if (item?.itemType !== 2 || item?.inventory?.tierType !== 6 || !icon?.startsWith(prefix))
      continue;
    icons[hash] = icon.slice(prefix.length);
  }
  return Object.fromEntries(Object.entries(icons).sort(([a], [b]) => Number(a) - Number(b)));
}

async function main() {
  const { inventory, source } = await loadPinnedInventory();
  const icons = extract(inventory, source.prefix);
  await writeFile(outUrl, `${JSON.stringify({ source, icons })}\n`);
  console.log(`Wrote ${Object.keys(icons).length} exotic armor icons`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
