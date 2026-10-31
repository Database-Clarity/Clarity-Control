import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseCompendiumSheet, parseCompendiumTabs } from './dist/parser.mjs';

// Reuse the downloaded acceptance HTML without making a network request.
const [htmlDirectory, output, fetchedAt] = process.argv.slice(2);
if (!htmlDirectory || !output || !fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) {
  throw new Error(
    'Usage: node measure-grid.mjs <cached HTML directory> <output.json> <source fetchedAt ISO>',
  );
}
const landing = await readFile(resolve(htmlDirectory, 'compendium-1027-landing.html'), 'utf8');
const tabs = [];
for (const tab of parseCompendiumTabs(landing)) {
  const html = await readFile(resolve(htmlDirectory, `compendium-1027-${tab.gid}.html`), 'utf8');
  tabs.push(parseCompendiumSheet(html, tab.gid, tab.name));
}
const json = JSON.stringify({ fetchedAt, tabs }) + '\n';
const bytes = Buffer.byteLength(json);
console.info(
  JSON.stringify(
    {
      source: 'cached HTML; no fresh fetch',
      bytes,
      gzipBytes: gzipSync(json).length,
      tabs: tabs.length,
      rows: tabs.reduce((sum, tab) => sum + tab.rows.length, 0),
      gridCells: tabs.reduce((sum, tab) => sum + tab.grid.length, 0),
    },
    null,
    2,
  ),
);
if (bytes > 15_000_000)
  throw new Error('Grid exceeds 15 MB; add split/gzip delivery before publication');
await writeFile(output, json);
