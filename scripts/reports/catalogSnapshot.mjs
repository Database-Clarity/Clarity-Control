import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const response = await fetch(
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/report-items.worker.json',
  { signal: AbortSignal.timeout(30000) },
);
if (!response.ok) throw new Error(`Report catalog HTTP ${response.status}`);
const text = await response.text();
const data = JSON.parse(text);
if (!/^[a-f0-9]{40}$/.test(data.sourceCommit) || !data.items || Array.isArray(data.items))
  throw new Error('Invalid catalog');
// The digest fast path may slice only this exact, flat producer serialization.
for (const [hash, item] of Object.entries(data.items)) {
  if (
    !/^\d+$/.test(hash) ||
    Number(hash) > 0xffffffff ||
    !Number.isInteger(item.owner) ||
    item.owner < 0 ||
    item.owner > 0xffffffff ||
    !Array.isArray(item.langs) ||
    item.langs.length > 13 ||
    !item.langs.every((lang) =>
      [
        'en',
        'de',
        'es',
        'es-mx',
        'fr',
        'it',
        'ja',
        'ko',
        'pl',
        'pt-br',
        'ru',
        'zh-chs',
        'zh-cht',
      ].includes(lang),
    ) ||
    !/^(base|enhanced|override:\d+)$/.test(item.variant) ||
    Object.keys(item).sort().join(',') !== 'langs,owner,variant'
  )
    throw new Error(`Invalid catalog item ${hash}`);
}
if (
  text.trim() !== JSON.stringify(data) ||
  Object.keys(data).sort().join(',') !== 'generatorCommit,items,sourceCommit,v' ||
  data.v !== 1 ||
  !/^[a-f0-9]{40}$/.test(data.generatorCommit)
)
  throw new Error('Unsupported catalog serialization');
writeFileSync(
  new URL('../../apps/worker/src/reportCatalogSnapshot.json', import.meta.url),
  JSON.stringify({
    sha256: createHash('sha256').update(text).digest('hex'),
    sourceCommit: data.sourceCommit,
  }) + '\n',
);
