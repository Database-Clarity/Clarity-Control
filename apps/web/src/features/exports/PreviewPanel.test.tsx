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

test('showcase defaults independently of recent picks, and can be restored after a selection', async () => {
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
  const render = async (pick: string | null) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <PreviewPanel projectId="example" state={state} file={file} pick={pick} onPick={onPick} />
        </MemoryRouter>,
      ),
    );
  try {
    await render(null);
    expect(host.querySelector('[aria-label="Feature showcase preview"]')).not.toBeNull();
    await render('123');
    expect(host.querySelector('[aria-label="Feature showcase preview"]')).toBeNull();
    const restore = [...host.querySelectorAll('button')].find(
      (el) => el.textContent === 'Feature showcase',
    )!;
    await act(async () => restore.click());
    expect(onPick).toHaveBeenCalledWith('-1');
    await render('-1');
    expect(host.querySelector('[aria-label="Feature showcase preview"]')).not.toBeNull();
    expect(
      [...host.querySelectorAll('button')].find((el) => el.textContent === 'Diff vs live file')!
        .disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
