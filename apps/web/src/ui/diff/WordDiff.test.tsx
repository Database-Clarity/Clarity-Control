// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { WordDiff } from './WordDiff';

it('preserves default DOM and supplies exact after-side offsets without decorating struck text', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const args = { before: 'Damage 5 for 10 seconds.', after: 'Damage 6 for 12 seconds.' };
  try {
    await act(async () => root.render(<WordDiff {...args} />));
    const original = host.innerHTML;
    const offsets: { text: string; offset: number }[] = [];
    await act(async () =>
      root.render(
        <WordDiff
          {...args}
          renderAfter={(text, offset) => {
            offsets.push({ text, offset });
            return text;
          }}
        />,
      ),
    );
    expect(host.innerHTML).toBe(original);
    expect(offsets.map((part) => part.text).join('')).toBe(args.after);
    for (const part of offsets)
      expect(args.after.slice(part.offset, part.offset + part.text.length)).toBe(part.text);
    await act(async () =>
      root.render(
        <WordDiff {...args} renderAfter={(text, offset) => <b data-offset={offset}>{text}</b>} />,
      ),
    );
    expect(host.querySelector('del b')).toBeNull();
    expect(host.querySelector('ins b')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
