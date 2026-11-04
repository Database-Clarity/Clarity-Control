// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PickerStage } from './PickerStage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('retains a closed picker without rendering intervening entries, then opens the current entry', async () => {
  const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value() {
        this.removeAttribute('open');
      },
    },
  });
  const rendered = vi.fn();
  function Content({ entry }: { entry: string }) {
    const [selected, select] = useState(false);
    rendered(entry);
    return (
      <button onClick={() => select(true)}>
        {entry}: {selected ? 'selected' : 'unselected'}
      </button>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (open: boolean, entry: string) =>
    act(async () => {
      root.render(
        <PickerStage open={open} onBack={() => undefined}>
          <Content key={entry} entry={entry} />
        </PickerStage>,
      );
    });
  try {
    await render(true, 'A');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('dialog > div button')!.click(),
    );
    expect(document.querySelector('dialog')?.textContent).toContain('A: selected');
    rendered.mockClear();
    await render(false, 'B');
    await render(false, 'C');
    expect(rendered).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    await render(true, 'A');
    expect(document.querySelector('dialog')?.textContent).toContain('A: selected');
    await render(false, 'B');
    await render(true, 'C');
    expect(document.querySelector('dialog')?.textContent).toContain('C: unselected');
    expect(document.querySelector('dialog')?.textContent).not.toContain('A:');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (show) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
});
