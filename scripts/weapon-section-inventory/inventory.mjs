import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { weaponSectionHeadings } from '../../packages/core/src/markup/weaponHeadings.ts';

/** Preserve comments in the proposal; comment examples are not active sections. */
export function proposeHeadings(text) {
  const masked = text
    .replace(/\/\*[^]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '))
    .replace(/^ *\/\/.*$| +\/\/.*$/gm, (comment) => ' '.repeat(comment.length));
  const original = text.split(/\r?\n/);
  const sections = [];
  const proposed = masked
    .split(/\r?\n/)
    .map((line, index) => {
      // A line beginning inside a comment must not be interpreted as a delimiter.
      if (original[index].slice(0, line.search(/\S|$/)).trim()) return original[index];
      const replacement = weaponSectionHeadings(line);
      if (replacement === line) return original[index];
      const tail = original[index].slice(line.trimEnd().length);
      if (replacement.startsWith('<bold ')) {
        sections.push({ line: index + 1, original: original[index], heading: replacement });
      }
      return replacement + tail;
    })
    .join(text.includes('\r\n') ? '\r\n' : '\n');
  return { sections, proposed };
}

export function inventory(value, path = []) {
  if (typeof value === 'string') {
    const proposal = proposeHeadings(value);
    return proposal.sections.length ? [{ path, original: value, ...proposal }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => inventory(entry, [...path, key]));
}

async function filesAt(input) {
  const info = await stat(input);
  if (info.isFile()) return [input];
  const children = await readdir(input, { withFileTypes: true });
  const files = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name.startsWith('.') || child.name === 'node_modules') continue;
    const path = join(input, child.name);
    if (child.isDirectory()) files.push(...(await filesAt(path)));
    else if (child.isFile() && child.name.endsWith('.json')) files.push(path);
  }
  return files;
}

export async function scan(input) {
  const files = await filesAt(resolve(input));
  const findings = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const value = JSON.parse(source.replace(/^\uFEFF/, ''));
    for (const finding of inventory(value)) {
      findings.push({
        file,
        sha256: createHash('sha256').update(source).digest('hex'),
        ...finding,
      });
    }
  }
  return {
    mode: 'dry-run',
    input: resolve(input),
    filesScanned: files.length,
    sectionCount: findings.reduce((sum, finding) => sum + finding.sections.length, 0),
    findings,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error(
      'Usage: node scripts/weapon-section-inventory/inventory.mjs <editor-data directory or bundle.json>',
    );
    process.exitCode = 1;
  } else {
    // stdout only: this tool has no file-write or publication path.
    console.log(JSON.stringify(await scan(process.argv[2]), null, 2));
  }
}
