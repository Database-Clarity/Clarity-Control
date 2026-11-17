// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { newStyleFile, type StyleFile } from '@clarity/export';
import { fromConfig } from './configModel';
import { PreviewPanel, type LastOutput } from './PreviewPanel';

const preview = vi.hoisted(() => ({ state: { kind: 'loading' } as Record<string, unknown> }));
vi.mock('./useSite', () => {
  const site = { manifest: null, error: null };
  return {
    usePreview: () => ({ state: preview.state, newer: null }),
    useSiteStore: Object.assign((pick: (value: typeof site) => unknown) => pick(site), {
      getState: () => site,
    }),
  };
});

test('the showcase is the default pick, independent of recent picks, and can be picked again', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const file = newStyleFile('example', 'structured');
  const state = fromConfig(
    { schema: 1, id: 'example', name: 'Example', files: [file] },
    'a'.repeat(40),
  );
  const onPick = vi.fn();
  const lastOutput = { current: null };
  const render = async (pick: string | null) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <PreviewPanel
            projectId="example"
            state={state}
            file={file}
            pick={pick}
            onPick={onPick}
            language={null}
            onLanguage={() => undefined}
            lastOutput={lastOutput}
          />
        </MemoryRouter>,
      ),
    );
  const showcase = () =>
    [...host.querySelectorAll('button')].find((el) => el.textContent === 'Feature showcase')!;
  try {
    await render(null);
    expect(showcase().getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('Example only, not in your file');
    await render('123');
    expect(showcase().getAttribute('aria-pressed')).toBe('false');
    await act(async () => showcase().click());
    expect(onPick).toHaveBeenCalledWith('-1');
    // No published copy of an unsaved file: nothing to diff against.
    expect(
      [...host.querySelectorAll('button')].some((el) => el.textContent === 'Diff vs live file'),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('last-edit marks clear when another perk is picked, even one that is not in the file', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Perk 100 has two lines; the second is bold unless the file drops bold. Perk 200 is absent.
  const sample = vi.fn(async (file: StyleFile, hash: string) => ({
    preview:
      hash === '100'
        ? {
            kind: 'entry',
            entry: {
              hash: 100,
              descriptions: {
                en: [
                  { parts: [{ text: 'Plain' }] },
                  {
                    parts: [
                      file.format.symbols.bold?.mode === 'drop'
                        ? { text: 'Plain' }
                        : { text: 'Plain', style: ['bold'] },
                    ],
                  },
                ],
              },
            },
          }
        : { kind: 'absent', reason: 'Category weapon-trait is not chosen' },
    live: null,
  }));
  preview.state = { kind: 'ready', client: { sample } };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const keep = newStyleFile('example', 'structured');
  const drop = { ...keep, format: { ...keep.format, symbols: { ...keep.format.symbols } } };
  drop.format.symbols.bold = { mode: 'drop' };
  const state = fromConfig(
    { schema: 1, id: 'example', name: 'Example', files: [keep] },
    'a'.repeat(40),
  );
  const lastOutput: { current: LastOutput | null } = { current: null };
  const render = async (file: StyleFile, pick: string) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <PreviewPanel
            projectId="example"
            state={state}
            file={file}
            pick={pick}
            onPick={() => undefined}
            language={null}
            onLanguage={() => undefined}
            lastOutput={lastOutput}
          />
        </MemoryRouter>,
      ),
    );
  const marked = () => host.querySelectorAll('[data-changed]').length;
  try {
    await render(keep, '100');
    expect(marked()).toBe(0);
    await render(drop, '100');
    expect(marked()).toBe(1);
    expect(host.textContent).toContain('1 line changed by your last edit');
    await render(drop, '200');
    expect(host.textContent).toContain('Not in this file');
    await render(drop, '100');
    expect(marked()).toBe(0);
    expect(host.textContent).not.toContain('by your last edit');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    preview.state = { kind: 'loading' };
  }
});
