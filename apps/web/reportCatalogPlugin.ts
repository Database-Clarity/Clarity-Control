import type { Plugin } from 'vite';
import { reportCatalogSchema, type ReportCatalog } from './src/services/reportCatalog';

const source =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/report-items.json';
const count = 64;
/** Derived solely from the existing producer output. Never writes to editor-data. */
export function reportShards(catalog: ReportCatalog): ReportCatalog[] {
  const owners = Object.fromEntries(
    Object.entries(catalog.items)
      .filter(([hash, item]) => Number(hash) !== item.owner)
      .map(([hash, item]) => [hash, item.owner]),
  );
  const shards: ReportCatalog[] = Array.from({ length: count }, () => ({
    v: 1,
    sourceCommit: catalog.sourceCommit,
    items: {},
    owners,
  }));
  for (const [hash, item] of Object.entries(catalog.items)) {
    if (!/^\d+$/.test(hash) || Number(hash) > 0xffffffff) throw new Error('Invalid catalog hash');
    shards[Number(hash) % count].items[hash] = item;
  }
  return shards;
}
export function reportCatalogPlugin(): Plugin {
  let shards: string[];
  let dev = false;
  let owners: string;
  return {
    name: 'report-catalog-shards',
    configureServer(server) {
      dev = true;
      server.middlewares.use((req, res, next) => {
        const match = /^\/report-catalog\/(\d+)\.json$/.exec(req.url ?? '');
        if (!match) return next();
        const body = Number(match[1]) === 64 ? owners : shards?.[Number(match[1])];
        res.statusCode = body ? 200 : 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(body ?? '{}');
      });
    },
    async buildStart() {
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Report catalog: HTTP ${response.status}`);
      const derived = reportShards(reportCatalogSchema.parse(await response.json()));
      owners = JSON.stringify(derived[0].owners);
      shards = derived.map(({ v, sourceCommit, items }) =>
        JSON.stringify({ v, sourceCommit, items }),
      );
    },
    load(id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith('/src/reportCatalogUrls.ts')) return;
      const urls = [...shards, owners].map((body, i) =>
        dev
          ? JSON.stringify(`/report-catalog/${i}.json`)
          : `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: `report-catalog-${i}.json`, source: body })}`,
      );
      return `export default [${urls.join(',')}];`;
    },
  };
}
