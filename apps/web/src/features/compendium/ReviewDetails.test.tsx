// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ReviewDetails } from './ReviewDetails';

it('mounts on the first summary activation, and retains edited state through close/reopen', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let mounts = 0;
  let builds = 0;
  function Body() {
    const [value] = useState(() => {
      mounts++;
      return 'Initial note';
    });
    return createElement('input', { defaultValue: value });
  }
  try {
    act(() =>
      root.render(
        createElement(ReviewDetails, {
          summary: 'Details',
          children: () => {
            builds++;
            return createElement(Body);
          },
        }),
      ),
    );
    expect(mounts).toBe(0);
    expect(builds).toBe(0);
    expect(host.querySelector('input')).toBeNull();
    const summary = host.querySelector('summary')!;
    act(() => summary.click());
    const input = host.querySelector('input')!;
    expect(mounts).toBe(1);
    expect(builds).toBeGreaterThan(0);
    input.value = 'Unsaved note';
    act(() => summary.click());
    expect(host.querySelector('input')).toBe(input);
    act(() => summary.click());
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('Unsaved note');
    expect(mounts).toBe(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
