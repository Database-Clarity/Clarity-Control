// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { newStyleFile } from '@clarity/export';
import { fromConfig } from './configModel';
import { PreviewPanel } from './PreviewPanel';

vi.mock('./useSite', () => {
  const site = { manifest: null, error: null };
  return {
    usePreview: () => ({ state: { kind: 'loading' }, newer: null }),
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
