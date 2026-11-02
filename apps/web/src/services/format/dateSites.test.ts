import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|testSupport/.test(entry.name)
      ? [path]
      : [];
  });
}
const name = (path: string) => relative(root, path).split(sep).join('/');

describe('rendered dates go through the shared formatter', () => {
  it('has no ad-hoc date formatting outside services/format and ui/When', () => {
    const offenders = sources(root)
      .filter((path) => !name(path).startsWith('services/format/') && name(path) !== 'ui/When.tsx')
      .filter((path) =>
        /toLocale(Date|Time)?String\(|Intl\.DateTimeFormat|toUTCString\(/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map(name);
    expect(offenders).toEqual([]);
  });

  it('uses toISOString only to stamp data, never as JSX text', () => {
    const offenders = sources(root)
      .filter((path) => path.endsWith('.tsx') && name(path) !== 'ui/When.tsx')
      .filter((path) =>
        /\{[^{}]*toISOString\(\)[^{}]*\}/.test(
          readFileSync(path, 'utf8').replaceAll('new Date().toISOString()', ''),
        ),
      )
      .map(name);
    expect(offenders).toEqual([]);
  });
});
