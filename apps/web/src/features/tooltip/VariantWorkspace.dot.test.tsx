// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VariantWorkspace } from './VariantWorkspace';
import { usePaneStatus } from '../compendium/paneStatus';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  usePaneStatus.setState({ hash: undefined, status: undefined });
});

const render = () =>
  act(async () =>
    root.render(
      <VariantWorkspace
        editor={<div>Editor</div>}
        compendium={<div>Compendium pane</div>}
        initialPanel="compendium"
      />,
    ),
  );
const dot = () => host.querySelector('[role="tab"] [role="img"]');

it('marks the Compendium tab when the pane has matched or needs-review text, and only then', async () => {
  await render();
  expect(dot()).toBeNull();
  await act(async () => usePaneStatus.getState().set(5, 'matched'));
  expect(dot()?.getAttribute('aria-label')).toBe('Matched');
  expect(dot()?.closest('[role="tab"]')?.textContent).toContain('Compendium');
  await act(async () => usePaneStatus.getState().set(5, 'review'));
  expect(dot()?.getAttribute('aria-label')).toBe('Needs review');
  expect(dot()?.getAttribute('data-status')).toBe('review');
  await act(async () => usePaneStatus.getState().set(5, undefined));
  expect(dot()).toBeNull();
});

it('does not present a hidden pane result as current', async () => {
  await act(async () =>
    root.render(
      <VariantWorkspace editor={<div>Editor</div>} compendium={<div>Compendium pane</div>} />,
    ),
  );
  await act(async () => usePaneStatus.getState().set(5, 'matched'));
  expect(dot()).toBeNull();
});
