// Exotic weapon icons for the finder's weapon list: every exotic weapon definition's icon, keyed
// by item hash, from the exact DestinyInventoryItemDefinition component that manifest-facts.json
// pins (same URL, same sha256), so both files describe one manifest. The generator does not emit
// owner icons yet; once it does, this file and its script can go.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const factsUrl = new URL('../../apps/web/src/features/compendium/manifest-facts.json', import.meta.url);
const outUrl = new URL('../../apps/web/src/features/navigation/exotic-weapon-icons.json', import.meta.url);
const prefix = '/common/destiny2_content/icons/';

/** Exotic weapons (item type 3, tier 6) with an icon: hash -> icon file name under `prefix`. */
export function extract(inventory) {
  const icons = {};
  for (const [hash, item] of Object.entries(inventory)) {
    const icon = item?.displayProperties?.icon;
    if (item?.itemType !== 3 || item?.inventory?.tierType !== 6 || !icon?.startsWith(prefix)) continue;
    icons[hash] = icon.slice(prefix.length);
  }
  return Object.fromEntries(Object.entries(icons).sort(([a], [b]) => Number(a) - Number(b)));
}

async function main() {
  const facts = JSON.parse(await readFile(factsUrl, 'utf8'));
  const pinned = facts.source.components.DestinyInventoryItemDefinition;
  const response = await fetch(pinned.url);
  if (!response.ok) throw new Error(`${pinned.url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== pinned.sha256)
    throw new Error(`${pinned.url}: sha256 ${sha256} is not the pinned ${pinned.sha256}`);
  const icons = extract(JSON.parse(bytes.toString('utf8')));
  const result = {
    source: { manifestVersion: facts.source.manifestVersion, url: pinned.url, sha256, prefix },
    icons,
  };
  await writeFile(outUrl, `${JSON.stringify(result)}\n`);
  console.log(`Wrote ${Object.keys(icons).length} exotic weapon icons`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
