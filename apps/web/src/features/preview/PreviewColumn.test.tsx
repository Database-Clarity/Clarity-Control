// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import { PreviewColumn, type EnhancedView, type PreviewColumnProps } from './PreviewColumn';
import type { PreviewMode } from './previewMode';

const BASE = `Intro line.

Hits required:
• Submachine Guns: #e\${14-#d}
• Auto Rifles: #e\${12-#d}

var d = 0

enhanced (
var d = 1
#e Hit Requirements are decreased by 1.
)`;
const globals = (type: string): MarkupGlobals => ({
  variables: 'var e = 🡅',
  titles: '',
  type,
});
const enhanced: EnhancedView = {
  hash: 11,
  name: 'Perk enhanced',
  text: BASE,
  globals: globals('Weapon Trait Enhanced'),
  derived: true,
};

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

async function render(props: Partial<PreviewColumnProps> = {}) {
  const onMode = vi.fn();
  const onVariant = vi.fn();
  await act(async () =>
    root.render(
      <PreviewColumn
        hash={10}
        lang="en"
        name="Perk"
        categoryLabel="Weapon Trait"
        baseText={BASE}
        baseGlobals={globals('Weapon Trait')}
        enhanced={[enhanced]}
        mode="compare"
        onMode={onMode}
        variant={11}
        onVariant={onVariant}
        {...props}
      />,
    ),
  );
  return { onMode, onVariant };
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const pressed = () =>
  buttons()
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);

describe('PreviewColumn', () => {
  it('retains visible text and cancels obsolete preview documents while stepping', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) =>
      setTimeout(() => run(0), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const painted = vi.fn();
    try {
      await render({ hash: 10, baseText: 'Previous content', enhanced: [], mode: 'base' });
      await render({
        hash: 11,
        baseText: 'Skipped content',
        enhanced: [],
        mode: 'base',
        stepping: true,
        onDocumentPaint: painted,
      });
      expect(host.textContent).toContain('Previous content');
      await render({
        hash: 12,
        baseText: 'Newest content',
        enhanced: [],
        mode: 'base',
        stepping: true,
        onDocumentPaint: painted,
      });
      expect(host.textContent).toContain('Previous content');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(17);
      });
      expect(host.textContent).toContain('Newest content');
      expect(host.textContent).not.toContain('Skipped content');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(17);
      });
      expect(painted).toHaveBeenCalledWith(12);
      expect(painted).not.toHaveBeenCalledWith(11);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('acknowledges only the text that its deferred body actually committed', async () => {
    vi.useFakeTimers();
    const commits: { expected: string; rendered: string }[] = [];
    function Acknowledge({ expected }: { expected: string }) {
      useLayoutEffect(() => {
        commits.push({
          expected,
          rendered: host.querySelector('[class*="description"]')?.textContent ?? '',
        });
      });
      return null;
    }
    try {
      await render({
        baseText: 'Old text',
        enhanced: [],
        mode: 'base',
        acknowledgement: <Acknowledge expected="Old text" />,
      });
      await render({
        baseText: 'Skipped text',
        enhanced: [],
        mode: 'base',
        acknowledgement: <Acknowledge expected="Skipped text" />,
      });
      await act(async () => vi.advanceTimersByTimeAsync(20));
      await render({
        baseText: 'New text',
        enhanced: [],
        mode: 'base',
        acknowledgement: <Acknowledge expected="New text" />,
      });
      expect(host.querySelector('[class*="description"]')?.textContent).toBe('Old text');
      expect(commits.map((c) => c.expected)).toEqual(['Old text']);
      await act(async () => vi.advanceTimersByTimeAsync(40));
      expect(commits.map((c) => c.expected)).toEqual(['Old text', 'New text']);
      expect(commits.every(({ expected, rendered }) => expected === rendered)).toBe(true);
      await render({ hash: 99, baseText: 'Different document', enhanced: [], mode: 'base' });
      expect(host.querySelector('[class*="description"]')?.textContent).toBe('Different document');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows ONE perk header above Base | Enhanced | Compare', async () => {
    await render();
    expect(host.querySelectorAll('header')).toHaveLength(1);
    expect(buttons().map((button) => button.textContent)).toEqual(['Base', 'Enhanced', 'Compare']);
    const header = host.querySelector('header')!;
    const bar = host.querySelector('[role="group"]')!;
    // Header first, then the switch, then the body.
    expect(header.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelectorAll('img[alt]')).toHaveLength(0);
  });

  it('keeps the switch for an item with no enhanced version, with Enhanced and Compare dimmed', async () => {
    await render({ enhanced: [], mode: 'base', variant: undefined });
    expect(host.querySelector('[role="group"]')).not.toBeNull();
    expect(buttons().map((button) => [button.textContent, button.disabled])).toEqual([
      ['Base', false],
      ['Enhanced', true],
      ['Compare', true],
    ]);
    expect(pressed()).toEqual(['Base']);
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelectorAll('header')).toHaveLength(1);
  });

  it('compares in place: changed values, the enhanced-only line, and the count', async () => {
    await render();
    expect(pressed()).toEqual(['Compare']);
    expect(host.querySelector('[aria-live]')?.textContent).toBe('3 changes vs Base');
    expect(host.querySelectorAll('[data-kind="changed"]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-kind="added"]')).toHaveLength(1);
    // Struck base value, an arrow, the enhanced value; the unchanged words stay as they are.
    const row = host.querySelector('[data-kind="changed"]')!;
    expect(row.textContent).toContain('• Submachine Guns:');
    expect(row.textContent).toContain('14');
    expect(row.textContent).toContain('13');
    expect(row.querySelector('[role="img"]')).not.toBeNull();
    // Compare is one body under the one header: no second perk header.
    expect(host.querySelectorAll('header')).toHaveLength(1);
  });

  it('shows the plain Base or Enhanced render without comparison marks', async () => {
    for (const mode of ['base', 'enhanced'] as PreviewMode[]) {
      await render({ mode });
      expect(pressed()).toEqual([mode === 'base' ? 'Base' : 'Enhanced']);
      expect(host.querySelector('[data-compare]')).toBeNull();
      expect(host.querySelector('[aria-live]')?.textContent).toBe('');
      expect(host.textContent?.includes('Hit Requirements are decreased by 1.')).toBe(
        mode === 'enhanced',
      );
    }
  });

  it('reports the chosen view and, with several enhanced versions, which one', async () => {
    const second: EnhancedView = { ...enhanced, hash: 12, name: 'Other enhanced', derived: false };
    const { onMode, onVariant } = await render({ enhanced: [enhanced, second] });
    act(() =>
      buttons()
        .find((button) => button.textContent === 'Base')!
        .click(),
    );
    expect(onMode).toHaveBeenCalledWith('base');
    const select = host.querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Perk enhanced',
      'Other enhanced',
    ]);
    await act(async () => {
      select.value = '12';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onVariant).toHaveBeenCalledWith(12);
  });

  it('says so when nothing differs', async () => {
    await render({ enhanced: [{ ...enhanced, globals: globals('Weapon Trait') }] });
    expect(host.querySelector('[aria-live]')?.textContent).toBe('No changes vs Base');
  });
});

it('renders native arms in Base, Enhanced, and Compare, including an enhanced importer', async () => {
  const base = 'Damage {{10}{20}}.';
  const props = {
    baseText: base,
    enhanced: [
      {
        ...enhanced,
        text: 'import main from 10',
        derived: false,
        globals: { ...globals('Weapon Trait Enhanced'), imports: { 10: base } },
      },
    ],
  };
  await render({ ...props, mode: 'base' });
  expect(host.textContent).toContain('Damage 10.');
  expect(host.textContent).not.toContain('Damage 20.');
  await render({ ...props, mode: 'enhanced' });
  expect(host.textContent).toContain('Damage 20.');
  expect(host.textContent).not.toContain('Damage 10.');
  await render({ ...props, mode: 'compare' });
  expect(host.textContent).toContain('1 change');
  expect(host.textContent).toContain('10');
  expect(host.textContent).toContain('20');
  expect(host.textContent).not.toContain('{{');
});
