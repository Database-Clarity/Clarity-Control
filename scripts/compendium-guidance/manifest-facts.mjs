import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'https://www.bungie.net';
const generatorUrl = 'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2/items.json';
const types = ['DestinyInventoryItemDefinition', 'DestinyPlugSetDefinition', 'DestinyArtifactDefinition'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { data: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) };
}
const add = (map, hash, value) => { if (map[hash]) map[hash].push(value); };
export function compactUsages(usages) {
  const groups = new Map();
  for (const exemplar of usages) {
    const { ownerItemType, socketCategoryHash, ordinal } = exemplar;
    const key = JSON.stringify([ownerItemType, socketCategoryHash, ordinal]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { ownerItemType, socketCategoryHash, ordinal, count: 1, exemplar });
  }
  return [...groups.values()];
}
export function extract(generator, inventory, plugSets, artifacts) {
  const usages = Object.fromEntries(Object.keys(generator).map(hash => [hash, []]));
  const memberships = Object.fromEntries(Object.keys(generator).map(hash => [hash, []]));
  for (const owner of Object.values(inventory)) {
    const sockets = owner.sockets?.socketEntries ?? [];
    const categories = owner.sockets?.socketCategories ?? [];
    sockets.forEach((socket, socketIndex) => {
      const category = categories.find(c => c.socketIndexes?.includes(socketIndex));
      const socketCategoryHash = category?.socketCategoryHash ?? null;
      const ordinal = [4241085061, 590099826].includes(socketCategoryHash) ? category.socketIndexes.indexOf(socketIndex) : null;
      const push = (hash, source, plugSetHash = null) => {
        if (hash && usages[hash]) add(usages, hash, { ownerHash: owner.hash, ownerItemType: owner.itemType ?? null, socketIndex, socketCategoryHash, ordinal, source, plugSetHash });
      };
      push(socket.singleInitialItemHash, 'singleInitialItemHash');
      for (const plug of socket.reusablePlugItems ?? []) push(plug.plugItemHash, 'reusablePlugItems');
      for (const source of ['randomizedPlugSetHash', 'reusablePlugSetHash']) {
        const hash = socket[source];
        for (const plug of plugSets[hash]?.reusablePlugItems ?? []) push(plug.plugItemHash, source, hash);
      }
    });
    if (owner.preview?.artifactHash) for (const [categoryIndex, category] of (owner.preview.derivedItemCategories ?? []).entries()) {
      for (const [itemIndex, item] of (category.items ?? []).entries()) add(memberships, item.itemHash, { source: 'inventoryPreview', ownerHash: owner.hash, artifactHash: owner.preview.artifactHash, artifactName: artifacts[owner.preview.artifactHash]?.displayProperties?.name || inventory[owner.preview.artifactHash]?.displayProperties?.name || null, categoryIndex, itemIndex, item });
    }
  }
  for (const artifact of Object.values(artifacts)) {
    for (const [tierIndex, tier] of (artifact.tiers ?? []).entries()) {
      for (const [itemIndex, item] of (tier.items ?? []).entries()) add(memberships, item.itemHash, { source: 'artifact', artifactHash: artifact.hash, artifactName: artifact.displayProperties?.name || inventory[artifact.hash]?.displayProperties?.name || null, tierIndex, itemIndex, item });
    }
  }
  return Object.fromEntries(Object.keys(generator).map(hash => {
    const item = inventory[hash];
    return [hash, { inventory: item ? {
      displayName: item.displayProperties?.name ?? null, description: item.displayProperties?.description ?? null,
      itemCategoryHashes: item.itemCategoryHashes ?? null, itemType: item.itemType ?? null,
      plug: item.plug ? { plugCategoryIdentifier: item.plug.plugCategoryIdentifier ?? null, plugCategoryHash: item.plug.plugCategoryHash ?? null } : null,
      investmentStats: item.investmentStats ?? null, perks: item.perks ?? null, redacted: item.redacted ?? null,
      ammoType: item.equippingBlock?.ammoType ?? null, powerCapHashes: item.quality?.versions?.map(v => v.powerCapHash ?? null) ?? null,
      tooltipNotifications: item.tooltipNotifications ?? null
    } : null, plugUsages: compactUsages(usages[hash]), artifactMemberships: memberships[hash], retired: null, sunset: null, currentArtifact: null }];
  }));
}
async function main() {
  const [manifest, generator] = await Promise.all([get(`${base}/Platform/Destiny2/Manifest/`), get(generatorUrl)]);
  if (manifest.data.ErrorCode !== 1) throw new Error(`Manifest API: ${manifest.data.Message}`);
  const metadata = manifest.data.Response;
  const components = await Promise.all(types.map(async type => {
    const url = new URL(metadata.jsonWorldComponentContentPaths.en[type], base).href;
    const result = await get(url);
    return [type, { url, sha256: result.sha256, data: result.data }];
  }));
  const byType = Object.fromEntries(components);
  const result = { source: { manifestVersion: metadata.version, manifestUrl: `${base}/Platform/Destiny2/Manifest/`, manifestSha256: manifest.sha256, generatorUrl, generatorSha256: generator.sha256, components: Object.fromEntries(components.map(([type, { url, sha256 }]) => [type, { url, sha256 }])) }, items: extract(generator.data, ...types.map(type => byType[type].data)) };
  await writeFile(new URL('../../apps/web/src/features/compendium/manifest-facts.json', import.meta.url), JSON.stringify(result));
  console.log(`Wrote ${Object.keys(result.items).length} items; ${Object.values(result.items).filter(x => x.inventory).length} matched inventory definitions`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

