// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { usePreviewWarnings } from './usePreviewWarnings';

const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let count = -1;
function Probe({ visible = true, scheduled = [10] }: { visible?: boolean; scheduled?: number[] }) {
  count = usePreviewWarnings()(10, scheduled, visible);
  return null;
}
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  usePreviewReviewStore.setState({ entries: {} });
  root = createRoot(host);
  act(() => root.render(<Probe />));
}
function edit(dirty: number, reviewed = 0) {
  act(() =>
    usePreviewReviewStore.setState({ entries: { 10: { canonical: 10, dirty, reviewed } } }),
  );
}
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('never warns for 50 revisions that render before the watchdog, without acknowledging for the guard', () => {
  mount();
  for (let revision = 1; revision <= 50; revision++) {
    edit(revision, revision - 1);
    expect(count).toBe(0);
    expect(usePreviewReviewStore.getState().unreviewed(10)).toEqual([10]);
    act(() => vi.advanceTimersByTime(60));
    edit(revision, revision);
    expect(count).toBe(0);
  }
});
it('warns for hidden previews, other modes, and failed renders, and clears after acknowledgement', () => {
  mount();
  edit(1);
  act(() => root.render(<Probe visible={false} />));
  expect(count).toBe(1);
  act(() => root.render(<Probe scheduled={[11]} />));
  expect(count).toBe(1);
  act(() => root.render(<Probe />));
  expect(count).toBe(0);
  act(() => vi.advanceTimersByTime(250));
  expect(count).toBe(1);
  edit(1, 1);
  expect(count).toBe(0);
  edit(2, 1);
  expect(count).toBe(0);
  act(() => usePreviewReviewStore.setState({ entries: {} }));
  edit(1);
  expect(count).toBe(0);
});

it('preserves a stalled revision deadline across unrelated edits and acknowledgements', () => {
  mount();
  edit(1);
  const stalled = usePreviewReviewStore.getState().entries[10]!;
  for (let revision = 1; revision <= 5; revision++) {
    act(() => vi.advanceTimersByTime(100));
    act(() =>
      usePreviewReviewStore.setState({
        entries: {
          10: stalled,
          20: { canonical: 20, dirty: revision, reviewed: revision },
        },
      }),
    );
    expect(count).toBe(revision < 3 ? 0 : 1);
  }
});
it('preserves the deadline when an older render is acknowledged without showing the latest edit', () => {
  mount();
  edit(3);
  act(() => vi.advanceTimersByTime(100));
  edit(3, 1);
  act(() => vi.advanceTimersByTime(150));
  expect(count).toBe(1);
  edit(3, 2);
  expect(count).toBe(1);
  edit(3, 3);
  expect(count).toBe(0);
});
it('cancels every pending deadline on unmount', () => {
  mount();
  edit(1);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
  act(() => root.render(<Probe />));
  expect(count).toBe(0);
});
