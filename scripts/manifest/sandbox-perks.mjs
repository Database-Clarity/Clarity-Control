// Writes the compact sandbox perk text the editor's "Manifest text" row falls back to for items
// that have no description of their own (artifact perks, armour mods, fragments, ...).
// Source: Bungie's DestinySandboxPerkDefinition, limited to the perk hashes the generator's items
// list in `sandboxPerkHashes`. Run after a manifest update: node scripts/manifest/sandbox-perks.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'https://www.bungie.net';
const generatorUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2/items.json';

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** `{ perkHash: [name, description] }` for every referenced perk that has a description. */
export function extract(generator, sandboxPerks) {
  const hashes = new Set();
  for (const item of Object.values(generator))
    for (const hash of item.sandboxPerkHashes ?? []) hashes.add(hash);
  const perks = {};
  for (const hash of [...hashes].sort((x, y) => x - y)) {
    const display = sandboxPerks[hash]?.displayProperties;
    const description = display?.description?.trim();
    if (description) perks[hash] = [display.name?.trim() ?? '', description];
  }
  return { referenced: hashes.size, perks };
}

async function main() {
  const [manifest, generator] = await Promise.all([
    get(`${base}/Platform/Destiny2/Manifest/`),
    get(generatorUrl),
  ]);
  if (manifest.ErrorCode !== 1) throw new Error(`Manifest API: ${manifest.Message}`);
  const metadata = manifest.Response;
  const url = new URL(metadata.jsonWorldComponentContentPaths.en.DestinySandboxPerkDefinition, base)
    .href;
  const { referenced, perks } = extract(generator, await get(url));
  const result = { source: { manifestVersion: metadata.version, url, generatorUrl }, perks };
  await writeFile(
    new URL('../../apps/web/src/features/manifest/sandbox-perks.json', import.meta.url),
    JSON.stringify(result),
  );
  console.log(
    `Wrote ${Object.keys(perks).length} described sandbox perks of ${referenced} referenced (${metadata.version})`,
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
