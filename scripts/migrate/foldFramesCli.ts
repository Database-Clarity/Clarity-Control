import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { aliasesSchema } from '@clarity/core';
import { z } from 'zod';
import { foldFrames } from './foldFrames.js';
import { readJson, readMigration } from './migrate.js';
import { deletedHashes, excludedDeletions } from './deletions.js';
import { planFold } from './foldWrite.js';
import { commitFiles, dataDiff } from './transaction.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    aliases: { type: 'string' },
    items: { type: 'string' },
    conflicts: { type: 'string' },
    deletions: { type: 'string' },
    reimport: { type: 'string', multiple: true },
    diff: { type: 'string' },
    approve: { type: 'string' },
    'allow-authored-overwrite': { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
  },
});
if (!values.data || !values.aliases || !values.items || !values.conflicts) {
  throw new Error(
    'Required: --data <checkout> --aliases <json> --items <json> --conflicts <file-in-checkout> [--diff <new-json>] [--write --approve <reviewed-diff.json>]',
  );
}
const existing = await readMigration(values.data);
if (!existing) throw new Error('No existing editor data to fold');
const excluded = excludedDeletions(
  await deletedHashes(values.data, values.deletions),
  values.reimport,
);
const result = foldFrames(
  existing.tooltips,
  aliasesSchema.parse(await readJson(values.aliases)),
  existing.pushed,
  z.record(z.string(), z.object({ name: z.string() })).parse(await readJson(values.items)),
);
const changes = await planFold(values.data, existing, result, values.conflicts, excluded);
const diff = dataDiff(changes);
console.log(
  JSON.stringify(
    {
      mode: values.write ? 'write' : 'dry run',
      before: existing.tooltips.length,
      after: result.tooltips.length,
      folded: result.folded,
      replacedLanguageVersions: result.conflicts.length,
      diff,
    },
    null,
    2,
  ),
);
if (values.diff) await writeFile(values.diff, `${JSON.stringify(diff, null, 2)}\n`, { flag: 'wx' });
if (values.write) {
  await commitFiles(values.data, changes, {
    approvedPlan: values.approve ? await readJson(values.approve) : undefined,
    allowAuthoredOverwrite: values['allow-authored-overwrite'],
  });
}
