// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { ReviewQueue } from './ReviewQueue';

it('bounds a long queue, reveals deep URL selections, and keeps keyboard access across windows', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes = Array.from({ length: 2500 }, (_, hash) => ({
    hash,
    name: `Tooltip ${hash}`,
    category: 'Perk',
  }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ReviewQueue changes={changes} selectedHash="1800" />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelectorAll('li').length).toBeLessThan(30);
    const selected = host.querySelector<HTMLAnchorElement>('[aria-current="page"]')!;
    expect(selected.getAttribute('href')).toBe('/review?hash=1800');
    selected.focus();
    await act(async () =>
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=2499');
    expect(host.querySelectorAll('li').length).toBeLessThan(30);
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      ),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=0');
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      ),
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/review?hash=1');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
