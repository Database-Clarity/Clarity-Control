// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavePanel } from './SavePanel';
import { usePreviewReviewStore } from '../../stores/previewReview';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://api.example',
}));

let host: HTMLDivElement;
let root: Root;
const text = () => {
  act(() => root.render(<SavePanel />));
  return host.querySelector('[data-unpreviewed]')?.textContent ?? null;
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  usePreviewReviewStore.setState({ entries: {} });
});

describe('save panel: changes not previewed', () => {
  it('says nothing when every edit was previewed', () => {
    usePreviewReviewStore.setState({ entries: { 1: { canonical: 1, dirty: 2, reviewed: 2 } } });
    expect(text()).toBeNull();
  });

  it('counts unseen edits and says saving is still allowed', () => {
    usePreviewReviewStore.setState({
      entries: {
        1: { canonical: 1, dirty: 3, reviewed: 1 },
        2: { canonical: 2, dirty: 1, reviewed: 0 },
        3: { canonical: 3, dirty: 1, reviewed: 1 },
      },
    });
    expect(text()).toMatch(/^2 changes not previewed\..*still save/);
    act(() =>
      usePreviewReviewStore.setState({ entries: { 2: { canonical: 2, dirty: 1, reviewed: 0 } } }),
    );
    expect(host.querySelector('[data-unpreviewed]')?.textContent).toMatch(/^1 change not/);
  });
});
