// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { EnglishRaw } from './EnglishRaw';
import { ReadingSlots } from '../preview/ReadingTooltip';

it('adds source marks only when opted in, and restores the exact default read-only markup DOM', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host),
    text = 'Damage 5.';
  const render = (slots: { text: string; ids: readonly number[] } | undefined) => (
    <ReadingSlots.Provider value={slots}>
      <EnglishRaw text={text} />
    </ReadingSlots.Provider>
  );
  try {
    await act(async () => root.render(render(undefined)));
    const original = host.querySelector('.cm-content')!.innerHTML;
    expect(host.querySelector('[data-slot]')).toBeNull();
    await act(async () => root.render(render({ text, ids: [7] })));
    expect(host.querySelector('[data-slot="7"]')?.textContent).toBe('5');
    expect(host.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(host.querySelector('.cm-content')?.textContent).toBe(text);
    await act(async () => root.render(render(undefined)));
    expect(host.querySelector('.cm-content')!.innerHTML).toBe(original);
  } finally {
    await act(async () => root.unmount());
  }
});
