// Compact investment stats for the preview; never loads Compendium facts at runtime.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const base = 'https://www.bungie.net';
const generatorUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2/items.json';
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}
export function extract(generator, inventory, definitions) {
  const items = {},
    names = {};
  for (const hash of Object.keys(generator)) {
    const stats = inventory[hash]?.investmentStats;
    if (!stats?.length) continue;
    items[hash] = stats.map(({ statTypeHash, value, isConditionallyActive }) => {
      names[statTypeHash] =
        definitions[statTypeHash]?.displayProperties?.name || String(statTypeHash);
      return [statTypeHash, value, !!isConditionallyActive];
    });
  }
  return { items, names };
}
async function main() {
  const [manifest, generator] = await Promise.all([
    get(`${base}/Platform/Destiny2/Manifest/`),
    get(generatorUrl),
  ]);
  if (manifest.ErrorCode !== 1) throw new Error(manifest.Message);
  const metadata = manifest.Response;
  const paths = metadata.jsonWorldComponentContentPaths.en;
  const urls = ['DestinyInventoryItemDefinition', 'DestinyStatDefinition'].map(
    (type) => new URL(paths[type], base).href,
  );
  const [inventory, definitions] = await Promise.all(urls.map(get));
  const result = {
    source: { manifestVersion: metadata.version, generatorUrl, urls },
    ...extract(generator, inventory, definitions),
  };
  const bytes = JSON.stringify(result);
  await writeFile(
    new URL('../../apps/web/src/features/manifest/investment-stats.json', import.meta.url),
    bytes,
  );
  console.log(
    `${Object.keys(result.items).length} items; ${Buffer.byteLength(bytes)} raw bytes; ${gzipSync(bytes).length} gzip bytes`,
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
