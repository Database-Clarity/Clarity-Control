// @vitest-environment jsdom
import { act, createElement, lazy, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SkeletonBoundary,
  SkeletonSuspense,
  SkeletonLine,
  SkeletonRegion,
  SkeletonRows,
  skeletonLineWidths,
  skeletonTextShape,
  skeletonMinimumMs,
  useSkeletonVisible,
} from './Skeleton';

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function Pending({
  pending,
  entry = 1,
  content = true,
}: {
  pending: boolean;
  entry?: number;
  content?: boolean;
}) {
  const visible = useSkeletonVisible(pending, entry, content);
  return visible ? (
    <SkeletonRegion>
      <SkeletonLine width={58} />
    </SkeletonRegion>
  ) : (
    <span>Retained content</span>
  );
}
async function frame() {
  const batch = [...frames.values()];
  frames.clear();
  await act(async () => batch.forEach((callback) => callback(0)));
}

it('keeps quick results visible and never flashes a skeleton before the second frame', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  expect(host.textContent).toBe('Retained content');
  await frame();
  expect(host.textContent).toBe('Retained content');
  await act(async () => root.render(createElement(Pending, { pending: false })));
  // The only remaining callback ends the unused loading cycle, without showing bars.
  await frame();
  expect(frames.size).toBe(0);
  expect(host.querySelector('[aria-hidden]')).toBeNull();
});

it('reveals on the second frame and retains the region across consecutive entries', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  await frame();
  await frame();
  const region = host.querySelector('[aria-hidden]');
  expect(region).not.toBeNull();
  await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
  expect(host.querySelector('[aria-hidden]')).toBe(region);
  // The newer entry gets its own two frames; ready within them, it shows directly.
  expect(frames.size).toBeGreaterThan(0);
  await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
  expect(host.textContent).toBe('Retained content');
});

describe('minimum visible time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const shown = () => host.querySelector('[aria-hidden]') !== null;

  it('keeps a shown skeleton for the minimum when the load finishes early, then swaps in', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.render(createElement(Pending, { pending: false })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 101));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe('Retained content');
  });

  it('swaps in at once after a slow load that outlasted the minimum', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs + 500));
    await act(async () => root.render(createElement(Pending, { pending: false })));
    expect(host.textContent).toBe('Retained content');
  });

  it('keeps counting the minimum across a step while the skeleton stays on screen, no restart or stacking', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
    expect(shown()).toBe(true);
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(50));
    await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
    // Shown for 150 ms in all: the rest of the one minimum, not a fresh one.
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 151));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe('Retained content');
  });

  it('swaps in the entry a flick stops on once it loads, after the skeleton showed through the flick', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    // Every step lands on a new entry while the skeleton stays on screen, some within two frames.
    for (let entry = 2; entry <= 30; entry++) {
      await act(async () => root.render(createElement(Pending, { pending: true, entry })));
      if (entry % 3) await frame();
      await act(async () => vi.advanceTimersByTime(16));
    }
    expect(shown()).toBe(true);
    await frame();
    await frame();
    await act(async () => root.render(createElement(Pending, { pending: false, entry: 30 })));
    expect(host.textContent).toBe('Retained content');
  });

  it('gives the next entry a fresh minimum after an error replaced the skeleton', async () => {
    const draw = (pending: boolean, identity: number, error = false) =>
      act(async () =>
        root.render(
          <SkeletonBoundary pending={pending} identity={identity} error={error} label="Loading">
            <p>{error ? 'Failed' : `Item ${identity}`}</p>
          </SkeletonBoundary>,
        ),
      );
    await draw(false, 1);
    await draw(true, 1);
    await frame();
    await frame();
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(100));
    await draw(false, 1, true);
    expect(host.textContent).toBe('Failed');
    await act(async () => vi.advanceTimersByTime(10));
    await draw(true, 2);
    await frame();
    await frame();
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(40));
    await draw(false, 2);
    await act(async () => vi.advanceTimersByTime(50));
    // Shown 90 ms for this wait: the interrupted minimum of entry 1 does not carry over.
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 90));
    expect(host.textContent).toBe('Item 2');
  });

  it('still swaps a warm entry in at once during the minimum', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(50));
    await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
    await frame();
    await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
    expect(host.textContent).toBe('Retained content');
  });

  it('gives a later wait a fresh minimum after the skeleton left the screen', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true })));
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs + 10));
    await act(async () => root.render(createElement(Pending, { pending: false })));
    expect(shown()).toBe(false);
    await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
    await frame();
    await frame();
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(20));
    await act(async () => root.render(createElement(Pending, { pending: false, entry: 2 })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 20));
    expect(shown()).toBe(false);
  });

  it('shows a first load at once and keeps it for the minimum', async () => {
    await act(async () => root.render(createElement(Pending, { pending: true, content: false })));
    await act(async () => root.render(createElement(Pending, { pending: false, content: false })));
    expect(shown()).toBe(true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(shown()).toBe(false);
  });
});

it('shows first loads immediately without requesting a frame', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true, content: false })));
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
  expect(frames.size).toBe(0);
});

it('cancels a superseded reveal and starts the newer entry window', async () => {
  await act(async () => root.render(createElement(Pending, { pending: true })));
  await frame();
  await act(async () => root.render(createElement(Pending, { pending: true, entry: 2 })));
  expect(frames.size).toBeGreaterThan(0);
  await frame();
  expect(host.textContent).toBe('Retained content');
  await frame();
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
});

it('sizes known text from character counts, preserves blank rows, and handles wrapping', () => {
  expect(skeletonLineWidths(skeletonTextShape('abcdefghij\n\nabc'), 100, 10)).toEqual([46, 0, 14]);
  expect(skeletonLineWidths(skeletonTextShape('a'.repeat(50)), 100, 10)).toEqual([100, 100, 28]);
  expect(skeletonLineWidths(skeletonTextShape('abcdefghij', 1), 100, 10)).toEqual([49]);
});

it('bounds table rows to the cached viewport capacity and hides all bars from accessibility', async () => {
  await act(async () =>
    root.render(
      <SkeletonRegion>
        <SkeletonRows count={50} maxRows={4} />
      </SkeletonRegion>,
    ),
  );
  expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  expect(host.firstElementChild?.children).toHaveLength(4);
});

it('removes old content immediately, skips fast-load shimmer, and exposes errors immediately', async () => {
  const render = (pending: boolean, identity: number, error = false) =>
    act(async () =>
      root.render(
        createElement(
          SkeletonBoundary,
          { pending, identity, error, label: 'Loading item' },
          createElement('p', null, error ? 'Failed' : `Item ${identity}`),
        ),
      ),
    );
  await render(false, 1);
  expect(host.textContent).toBe('Item 1');
  await render(true, 2);
  expect(host.textContent).not.toContain('Item 1');
  expect(host.querySelector('[aria-hidden]')).toBeNull();
  await frame();
  await render(false, 2);
  expect(host.textContent).toBe('Item 2');
  await render(true, 3);
  await frame();
  await frame();
  expect(host.querySelector('[aria-hidden]')).not.toBeNull();
  await render(false, 3, true);
  expect(host.textContent).toBe('Failed');
});

it('keeps resolved children behind the shown skeleton until its minimum elapses', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let resolve!: (value: { default: () => React.ReactElement }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => React.ReactElement }>((done) => {
          resolve = done;
        }),
    );
    await act(async () =>
      root.render(
        createElement(SkeletonSuspense, { label: 'Loading page', children: createElement(Page) }),
      ),
    );
    await frame();
    await frame();
    await act(async () => resolve({ default: () => createElement('p', null, 'Ready') }));
    expect(host.querySelector('[hidden]')?.textContent).toBe('Ready');
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(host.querySelector('[hidden]')).toBeNull();
    expect(host.textContent).toBe('Ready');
  } finally {
    vi.useRealTimers();
  }
});

it('hands a shown parent clock to nested boundaries instead of stacking minimums', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let resolve!: (value: { default: (props: { pending: boolean }) => React.ReactElement }) => void;
  const Page = lazy(
    () =>
      new Promise<{ default: (props: { pending: boolean }) => React.ReactElement }>((done) => {
        resolve = done;
      }),
  );
  const draw = (outer: boolean, inner: boolean) =>
    act(async () =>
      root.render(
        <SkeletonBoundary pending={outer} label="Outer">
          <SkeletonSuspense label="Loading import">
            <Page pending={inner} />
          </SkeletonSuspense>
        </SkeletonBoundary>,
      ),
    );
  const paint = () =>
    act(async () => {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((callback) => callback(0));
    });
  try {
    await draw(true, true);
    await paint();
    await paint();
    await act(async () => vi.advanceTimersByTime(100));
    await draw(false, true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 100));
    expect(host.textContent).toBe('Loading import');
    // A slow lazy import can take more than two frames after its parent finishes.
    // Its pending Suspense holder keeps the cycle open until the import commits.
    await paint();
    await paint();
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () =>
      resolve({
        default: ({ pending }) => (
          <SkeletonBoundary pending={pending} label="Inner">
            <p>Ready</p>
          </SkeletonBoundary>
        ),
      }),
    );
    expect(host.textContent).toBe('Inner');
    await paint();
    await paint();
    await draw(false, false);
    expect(host.textContent).toBe('Ready');
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('does not flash a boundary whose warm result commits before frame two', async () => {
  await act(async () =>
    root.render(
      <SkeletonBoundary pending label="Warm">
        <p>Ready</p>
      </SkeletonBoundary>,
    ),
  );
  await frame();
  await act(async () =>
    root.render(
      <SkeletonBoundary pending={false} label="Warm">
        <p>Ready</p>
      </SkeletonBoundary>,
    ),
  );
  expect(host.querySelector('[aria-hidden]')).toBeNull();
  expect(host.textContent).toBe('Ready');
});

it('shares the minimum with a descendant mounting the frame after its parent reveals', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  function AfterReveal({ pending }: { pending: boolean }) {
    const [mounted, setMounted] = useState(false);
    useLayoutEffect(() => {
      const next = requestAnimationFrame(() => flushSync(() => setMounted(true)));
      return () => cancelAnimationFrame(next);
    }, []);
    return mounted ? (
      <SkeletonBoundary pending={pending} label="Inner">
        <p>Ready</p>
      </SkeletonBoundary>
    ) : null;
  }
  const draw = (outer: boolean, inner: boolean) =>
    act(async () =>
      root.render(
        <SkeletonBoundary pending={outer} label="Outer">
          <AfterReveal pending={inner} />
        </SkeletonBoundary>,
      ),
    );
  try {
    await draw(true, true);
    await frame();
    await frame();
    await draw(false, true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(host.textContent).toBe('');
    await act(async () => vi.advanceTimersByTime(16));
    await frame();
    expect(host.textContent).toBe('Inner');
    await frame();
    await frame();
    await act(async () => vi.advanceTimersByTime(50));
    await draw(false, false);
    expect(host.textContent).toBe('Ready');
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['boundary', 'suspense'])(
  'starts a new navigation minimum through an already mounted intermediate %s',
  async (intermediate) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const paint = () =>
      act(async () => {
        const batch = [...frames.values()];
        frames.clear();
        batch.forEach((callback) => callback(0));
      });
    const draw = (navigation: number, outer: boolean, inner: boolean) =>
      act(async () =>
        root.render(
          <SkeletonBoundary identity={navigation} pending={outer} label="Layout">
            {intermediate === 'boundary' ? (
              <SkeletonBoundary pending={false} label="Page">
                <SkeletonBoundary identity={navigation} pending={inner} label="Detail">
                  <p>Ready {navigation}</p>
                </SkeletonBoundary>
              </SkeletonBoundary>
            ) : (
              <SkeletonSuspense label="Page">
                <SkeletonBoundary identity={navigation} pending={inner} label="Detail">
                  <p>Ready {navigation}</p>
                </SkeletonBoundary>
              </SkeletonSuspense>
            )}
          </SkeletonBoundary>,
        ),
      );
    try {
      await draw(1, true, false);
      await paint();
      await paint();
      await draw(1, false, false);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(host.textContent).toBe('Ready 1');
      await draw(2, false, true);
      await paint();
      await paint();
      expect(host.querySelector('[aria-hidden]')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(50));
      await draw(2, false, false);
      expect(host.querySelector('[aria-hidden]')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 50));
      expect(host.textContent).toBe('Ready 2');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('shares the elapsed parent minimum with a first-load hook consumer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const paint = () =>
    act(async () => {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((callback) => callback(0));
    });
  const draw = (outer: boolean, inner: boolean) =>
    act(async () =>
      root.render(
        <SkeletonBoundary pending={outer} label="Layout">
          <Pending pending={inner} content={false} />
        </SkeletonBoundary>,
      ),
    );
  try {
    await draw(true, true);
    await paint();
    await paint();
    await draw(false, true);
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs));
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(50));
    await draw(false, false);
    expect(host.querySelector('[aria-hidden]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('gives a later nested selection its own minimum while its parent stays mounted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const paint = () =>
    act(async () => {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((callback) => callback(0));
    });
  const draw = (entry: number, pending: boolean) =>
    act(async () =>
      root.render(
        <SkeletonBoundary pending={false} identity="same-route" label="Page">
          <SkeletonBoundary pending={pending} identity={entry} label="Selection">
            <p>Ready {entry}</p>
          </SkeletonBoundary>
        </SkeletonBoundary>,
      ),
    );
  try {
    await draw(1, true);
    await paint();
    await paint();
    await draw(1, false);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(host.textContent).toBe('Ready 1');
    await paint(); // The idle browser frame ends the completed cycle.
    await draw(2, true);
    expect(host.textContent).not.toContain('Ready 1');
    await paint();
    await paint();
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(50));
    await draw(2, false);
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 50));
    expect(host.textContent).toBe('Ready 2');
  } finally {
    vi.useRealTimers();
  }
});

it('gives a reload on the same boundary a fresh minimum', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const draw = (pending: boolean) =>
    act(async () =>
      root.render(
        <SkeletonBoundary pending={pending} label="Reloadable rows">
          <p>Ready</p>
        </SkeletonBoundary>,
      ),
    );
  try {
    await draw(true);
    await frame();
    await frame();
    await draw(false);
    await act(async () => vi.advanceTimersByTime(1000));
    await frame(); // The idle browser frame ends the completed cycle.
    await draw(true);
    await frame();
    await frame();
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(50));
    await draw(false);
    expect(host.querySelector('[aria-hidden]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(skeletonMinimumMs - 50));
    expect(host.textContent).toBe('Ready');
  } finally {
    vi.useRealTimers();
  }
});
