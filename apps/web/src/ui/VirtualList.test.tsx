// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VirtualList } from './VirtualList';

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
});

type Item = { key: number; header?: boolean };
const items = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ key: i, header: i % 10 === 0 }));
const render = async (list: Item[], reveal?: number) =>
  act(async () =>
    root.render(
      createElement(VirtualList<Item>, {
        items: list,
        heightRem: (item) => (item.header ? 1.5 : 2),
        itemKey: (item) => item.key,
        renderItem: (item) => createElement('span', { 'data-key': item.key }, item.key),
        label: 'List',
        reveal,
      }),
    ),
  );
const rendered = () => host.querySelectorAll('[data-key]').length;

it('renders a bounded window of a long list', async () => {
  await render(items(2000));
  expect(rendered()).toBeGreaterThan(0);
  expect(rendered()).toBeLessThan(60);
});

it('keeps the whole track scrollable at its full height', async () => {
  await render(items(100));
  const track = host.querySelector<HTMLElement>('[aria-hidden="true"][style*="height"]')!;
  // 10 headers at 1.5rem and 90 rows at 2rem, at the 16px fallback unit.
  expect(parseFloat(track.style.height)).toBe((10 * 1.5 + 90 * 2) * 16);
});

it('renders far rows when asked to reveal one', async () => {
  await render(items(500));
  expect(host.querySelector('[data-key="400"]')).toBeNull();
  await render(items(500), 400);
  expect(host.querySelector('[data-key="400"]')).not.toBeNull();
});

it('survives the list shrinking below the scroll position', async () => {
  await render(items(500), 450);
  await render(items(5));
  expect(host.querySelector('[data-key="0"]')).not.toBeNull();
  expect(host.querySelector('[data-key="4"]')).not.toBeNull();
});
