// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { entries, excluded } from './entries';

const uiRoot = join(__dirname, '../../ui');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Exported React components under ui/**: PascalCase functions, and memo/forwardRef constants. */
function exportedComponents(): string[] {
  const names: string[] = [];
  for (const file of files(uiRoot)) {
    if (!file.endsWith('.tsx') || /\.test\.tsx$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /export\s+(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=\s*(?:memo|forwardRef)\b)/g,
    ))
      names.push(match[1] ?? match[2]!);
  }
  return names.sort();
}

describe('UI gallery coverage', () => {
  it('has an entry for every exported component under ui/', () => {
    const covered = new Set(entries.flatMap((entry) => entry.covers ?? []));
    const missing = exportedComponents().filter(
      (name) => !covered.has(name) && !(name in excluded),
    );
    // Add the component to an entry in features/gallery/entries.tsx (or, deliberately, to
    // `excluded` with the reason).
    expect(missing, `no gallery entry in ${relative(process.cwd(), uiRoot)}`).toEqual([]);
  });

  it('lists only real exports, and every exclusion has a reason', () => {
    const exported = new Set(exportedComponents());
    const named = [...entries.flatMap((entry) => entry.covers ?? []), ...Object.keys(excluded)];
    expect(named.filter((name) => !exported.has(name))).toEqual([]);
    for (const reason of Object.values(excluded)) expect(reason.trim()).not.toBe('');
  });

  it('renders every state without throwing', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    for (const entry of entries)
      for (const { label, View } of entry.states) {
        await act(async () => {
          root.render(
            <MemoryRouter>
              <View />
            </MemoryRouter>,
          );
        });
        expect(host.childNodes.length, `${entry.title}: ${label}`).toBeGreaterThan(0);
      }
    await act(async () => root.unmount());
    host.remove();
  });
});
