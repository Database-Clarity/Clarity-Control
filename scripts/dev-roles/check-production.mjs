import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const marker = /__clarity.local.role.harness|clarity-local-turnstile|scripts[/\\]dev-roles/i;

export async function checkProduction(directory) {
  let scripts = 0;
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    if (/\.[cm]?js$/.test(file.name)) scripts++;
    const path = join(file.parentPath, file.name);
    if (marker.test(path) || marker.test(await readFile(path, 'utf8')))
      throw new Error(`Local role harness found in production output: ${path}`);
  }
  if (!scripts) throw new Error(`No production JavaScript found in ${directory}`);
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  await checkProduction(resolve(process.argv[2]));
}
