// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { parseMarkup } from '@clarity/core';
import { Lines, MarkupLines, PreviewSpan, TitleAnchor } from './MarkupRenderer';

it('passes optional slot identity without changing the DOM of ordinary spans', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () => root.render(<PreviewSpan part={{ text: '5' }} />));
    expect(host.innerHTML).toBe('<span><span>5</span></span>');
    const ordinary = host.innerHTML;
    await act(async () =>
      root.render(<PreviewSpan part={{ text: '5', slots: [{ id: 7, from: 0, to: 1 }] }} />),
    );
    expect(host.querySelector('[data-slot="7"]')?.textContent).toBe('5');
    await act(async () => root.render(<PreviewSpan part={{ text: '5', slots: undefined }} />));
    expect(host.innerHTML).toBe(ordinary);
  } finally {
    await act(async () => root.unmount());
  }
});

it('retains number offsets when icon glue splits its following text span', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const source = '<solar/>Damage 5 and 10.';
  try {
    await act(async () =>
      root.render(<Lines lines={parseMarkup(source, undefined, { slots: [7, 8] }).lines} />),
    );
    expect(
      [...host.querySelectorAll('[data-slot]')].map((span) => [
        span.getAttribute('data-slot'),
        span.textContent,
      ]),
    ).toEqual([
      ['7', '5'],
      ['8', '10'],
    ]);
    expect(host.textContent).toContain('Damage 5 and 10.');
  } finally {
    await act(async () => root.unmount());
  }
});

it('offers variable typing help without making derived digits into a number slot', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const part = { text: 'Value 5.' };
  try {
    await act(async () => root.render(<PreviewSpan part={part} />));
    const original = host.innerHTML;
    await act(async () =>
      root.render(<PreviewSpan part={{ ...part, variables: [{ name: 'd', from: 6, to: 7 }] }} />),
    );
    expect(host.querySelector('[title="Variable d: type #{d}"]')?.textContent).toBe('5');
    expect(host.querySelector('[data-slot]')).toBeNull();
    await act(async () => root.render(<PreviewSpan part={{ ...part, variables: undefined }} />));
    expect(host.innerHTML).toBe(original);
  } finally {
    await act(async () => root.unmount());
  }
});

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
it('shares the same line and table tree for plain and decorated consumers', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const lines = freeze(
    parseMarkup('<pve Hits />\n< table wide >\n| <bold Cell />\n<$>', { variables: '', titles: '' })
      .lines,
  );
  try {
    await act(async () => root.render(<Lines lines={lines} />));
    const plain = host.innerHTML;
    await act(async () => root.render(<MarkupLines lines={lines} />));
    expect(host.innerHTML).toBe(plain);
    await act(async () =>
      root.render(
        <MarkupLines
          lines={lines}
          renderParts={(parts) => (
            <ins>
              {parts.map((part, index) => (
                <PreviewSpan key={index} part={part} />
              ))}
            </ins>
          )}
          beforeLine={(index) => (index === 1 ? <p>Located marker</p> : null)}
        />,
      ),
    );
    expect(host.querySelector('td ins')?.textContent).toContain('Cell');
    expect(host.querySelector('p')?.nextElementSibling?.tagName).toBe('TABLE');
  } finally {
    await act(async () => root.unmount());
  }
});
it('keeps an icon with the word right after it, and only that word', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const render = (text: string) => (
    <Lines lines={parseMarkup(text, { variables: '', titles: '' }).lines} />
  );
  const glued = () =>
    [...host.querySelectorAll('[class*=iconGlue]')].map((glue) => glue.textContent);
  try {
    await act(async () =>
      root.render(render('Gain <solar/>Scorch stacks and <solar Void Breaches />.')),
    );
    expect(glued()).toEqual(['Scorch', 'Void']);
    expect(host.textContent).toBe('Gain Scorch stacks and Void Breaches.');
    // A space after the icon still breaks; a line without an icon-word pair is not wrapped.
    await act(async () => root.render(render('Gain <solar/> Scorch and plain text.')));
    expect(glued()).toEqual([]);
    await act(async () =>
      root.render(render('Gain <arc/><bold Ionic />Traces at 50%<arrow/>40% and 🡅50%.')),
    );
    expect(glued()).toEqual(['IonicTraces', '50%40%', '🡅50%.']);
    expect(host.querySelector('[aria-label="leads to"]')?.parentElement?.textContent).toBe(
      '50%40%',
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps a hovered title open while the pointer crosses the gap into it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    await act(async () =>
      root.render(
        <TitleAnchor part={{ text: 'Term', title: [{ linesContent: [{ text: 'Body' }] }] }} />,
      ),
    );
    const anchor = host.querySelector<HTMLElement>('[aria-describedby]')!;
    const box = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    const pointer = (type: string, target: HTMLElement, related: Element) =>
      act(async () => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: related }));
      });
    await pointer('pointerover', anchor, document.body);
    await wait(160);
    expect(box.hasAttribute('data-open')).toBe(true);
    // Out of the anchor into the gap, then into the box (its child) within the grace.
    await pointer('pointerout', anchor, document.body);
    await wait(50);
    await pointer('pointerover', box, document.body);
    await wait(150);
    expect(box.hasAttribute('data-open')).toBe(true);
    // Leaving for good closes it after the grace.
    await pointer('pointerout', box, document.body);
    expect(box.hasAttribute('data-open')).toBe(true);
    await wait(160);
    expect(box.hasAttribute('data-open')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('keeps a hovered title at the pointer when the anchor is then pressed or focused', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () =>
      root.render(
        <TitleAnchor part={{ text: 'Term', title: [{ linesContent: [{ text: 'Body' }] }] }} />,
      ),
    );
    const anchor = host.querySelector<HTMLElement>('[aria-describedby]')!;
    const box = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    await act(async () => {
      anchor.dispatchEvent(
        new MouseEvent('pointerover', {
          bubbles: true,
          relatedTarget: document.body,
          clientX: 50,
          clientY: 60,
        }),
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 160)));
    expect(box.style.left).toBe('50px');
    await act(async () => {
      anchor.focus();
      anchor.click();
    });
    expect(box.hasAttribute('data-open')).toBe(true);
    expect(box.style.left).toBe('50px');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('opens a hovered title once the pointer rests, at its latest point; Escape keeps it shut', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  const at = (type: string, target: Element, x: number, y: number) =>
    act(async () => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          relatedTarget: document.body,
          clientX: x,
          clientY: y,
        }),
      );
    });
  try {
    await act(async () =>
      root.render(
        <TitleAnchor part={{ text: 'Term', title: [{ linesContent: [{ text: 'Body' }] }] }} />,
      ),
    );
    const anchor = host.querySelector<HTMLElement>('[aria-describedby]')!;
    const box = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    // Enters at the trigger's edge, moves on before the rest ends: it opens where it stopped.
    await at('pointerover', anchor, 40, 90);
    await wait(100);
    await at('pointermove', anchor, 70, 60);
    await wait(100);
    expect(box.hasAttribute('data-open')).toBe(false);
    await wait(80);
    expect(box.hasAttribute('data-open')).toBe(true);
    expect(box.style.left).toBe('70px');
    // Once open it stays put, like a native title.
    await at('pointermove', anchor, 90, 60);
    await wait(200);
    expect(box.style.left).toBe('70px');
    // Escape closes it; moving on over the anchor does not bring it back until the pointer leaves.
    await act(async () => {
      anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(box.hasAttribute('data-open')).toBe(false);
    await at('pointermove', anchor, 95, 60);
    await wait(200);
    expect(box.hasAttribute('data-open')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('hovers open again after Escape closed a keyboard-opened title', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () =>
      root.render(
        <TitleAnchor part={{ text: 'Term', title: [{ linesContent: [{ text: 'Body' }] }] }} />,
      ),
    );
    const anchor = host.querySelector<HTMLElement>('[aria-describedby]')!;
    const box = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    await act(async () => anchor.focus());
    await act(async () => {
      anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => anchor.blur());
    expect(box.hasAttribute('data-open')).toBe(false);
    await act(async () => {
      anchor.dispatchEvent(
        new MouseEvent('pointerover', {
          bubbles: true,
          relatedTarget: document.body,
          clientX: 70,
          clientY: 60,
        }),
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 160)));
    expect(box.hasAttribute('data-open')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
