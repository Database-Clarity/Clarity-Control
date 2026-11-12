// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FinderIcon } from './FinderIcon';

let host: HTMLDivElement;
let root: Root;
const afterPaint = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
const image = () => host.querySelector('img');

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

it('keeps the box and adds the image after the first paint', async () => {
  await act(async () => root.render(<FinderIcon icon="/common/a.png" />));
  expect(host.querySelector('span[aria-hidden]')).not.toBeNull();
  expect(image()).toBeNull();
  await afterPaint();
  expect(image()?.getAttribute('src')).toBe('https://www.bungie.net/common/a.png');
});

it('a failed icon leaves the box empty; a recycled row with another icon shows it', async () => {
  await act(async () => root.render(<FinderIcon icon="/common/broken.png" />));
  await afterPaint();
  await act(async () => void image()!.dispatchEvent(new Event('error')));
  expect(image()).toBeNull();
  expect(host.querySelector('span[aria-hidden]')).not.toBeNull();
  await act(async () => root.render(<FinderIcon icon="/common/valid.png" />));
  expect(image()?.getAttribute('src')).toBe('https://www.bungie.net/common/valid.png');
  expect(image()!.style.visibility).toBe('');
});
