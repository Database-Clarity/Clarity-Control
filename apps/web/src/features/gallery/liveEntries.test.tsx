// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it } from 'vitest';
import { liveEntries } from './liveEntries';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function FrameLocation() {
  const location = useLocation();
  return <output data-frame-location>{location.pathname + location.search}</output>;
}

it('keeps workspace and batch fixture activation inside the gallery with its settings intact', async () => {
  const initial = '/management/ui/frame?theme=light&scale=150&touch=large&q=workspace';
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const id of ['workspace-tabs', 'batch-row']) {
      const View = liveEntries.find((entry) => entry.id === id)!.states[0].View;
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={[initial]}>
            <View />
            <FrameLocation />
          </MemoryRouter>,
        );
      });
      const link = host.querySelector<HTMLAnchorElement>('a')!;
      expect(link).toBeTruthy();
      await act(async () => link.click());
      expect(host.querySelector('[data-frame-location]')!.textContent).toBe(initial);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
