// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { parseMarkup } from '@clarity/core';
import { Lines } from './MarkupRenderer';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

it('keeps immutable unchanged lines and updates styling, title bodies, and table cells', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const source = (tag: string, detail: string, cell: string) =>
    `Unchanged\n<${tag} Damage />\ntitle Detail (\n${detail}\n)\n<title Info [Detail] />\n< table wide >\n| ${cell}\n<$>`;
  const render = (text: string) => (
    <Lines lines={freeze(parseMarkup(text, { variables: '', titles: '' }).lines)} />
  );
  try {
    await act(async () => root.render(render(source('pve', 'Old detail', 'Old cell'))));
    const unchanged = host.firstElementChild;
    expect(host.querySelector('[class*=pve]')).not.toBeNull();
    expect(host.textContent).toContain('Old detail');
    expect(host.querySelector('td')?.textContent).toContain('Old cell');
    await act(async () => root.render(render(source('pvp', 'New detail', 'New cell'))));
    expect(host.firstElementChild).toBe(unchanged);
    expect(host.querySelector('[class*=pve]')).toBeNull();
    expect(host.querySelector('[class*=pvp]')).not.toBeNull();
    expect(host.textContent).toContain('New detail');
    expect(host.textContent).not.toContain('Old detail');
    expect(host.querySelector('td')?.textContent).toContain('New cell');
    const html = host.innerHTML;
    await act(async () => root.render(render(source('pvp', 'New detail', 'New cell'))));
    expect(host.innerHTML).toBe(html);
  } finally {
    await act(async () => root.unmount());
  }
});
