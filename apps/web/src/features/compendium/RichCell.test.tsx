// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CompendiumCell } from '@clarity/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Multiline, RichCell } from './RichCell';
import { createSettingsStore, useSettingsStore, deviceKey } from '../../stores/settings';
import { memoryStorage } from '../../stores/settings.testSupport';
import { CompendiumDiff } from './CompendiumDiff';

const cell = (...texts: string[]): CompendiumCell =>
  ({
    plain: texts.join(''),
    runs: texts.map((text, i) => ({ text, bold: i === 1, color: i === 1 ? '#ff0000' : undefined })),
  }) as CompendiumCell;
const TEXT = 'line1\nline2\n\nline4';

function render(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(node));
  return host;
}

describe('compendium newlines', () => {
  it('keeps the multiline white-space rule in the shared stylesheet', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'apps/web/src/features/compendium/RichCell.module.scss'),
      'utf8',
    );
    expect(css).toMatch(/\.multiline\s*{[^}]*white-space:\s*pre-wrap/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('RichCell wraps runs so newlines survive, styling kept', () => {
    const host = render(createElement(RichCell, { cell: cell('line1\nline2', '\n\nline4') }));
    const wrapper = host.querySelector('[data-multiline]')!;
    expect(wrapper.textContent).toBe(TEXT);
    expect(
      wrapper.querySelector<HTMLElement>('span span[style*="bold"], span span[style*="700"]'),
    ).not.toBeNull();
  });
  it('Multiline wraps plain picker text (buttons/list rows)', () => {
    const host = render(createElement('button', null, createElement(Multiline, null, TEXT)));
    expect(host.querySelector('button [data-multiline]')!.textContent).toBe(TEXT);
  });
  it('CompendiumDiff renders both sides through the multiline wrapper', () => {
    const host = render(
      createElement(CompendiumDiff, {
        before: cell('line1\nline2\n\nline4'),
        after: cell('line1\nline2\n\nline5'),
      }),
    );
    const wrappers = [...host.querySelectorAll('[data-multiline]')];
    expect(wrappers.length).toBeGreaterThan(0);
    expect(host.textContent).toContain('line1\nline2\n\nline');
  });
});

describe('alignment and diff preference', () => {
  beforeEach(() => useSettingsStore.getState().remember({ compendiumDiff: 'changes' }));
  const aligned = (text: string, textAlign: 'center' | 'right' = 'center'): CompendiumCell => ({
    plain: text,
    runs: [{ text, textAlign, bold: true }],
  });
  it('lays out mixed source lines with their own alignment and exact newlines', () => {
    const value: CompendiumCell = {
      plain: 'Centre\n\nRight',
      runs: [
        { text: 'Centre\n\n', textAlign: 'center', bold: true },
        { text: 'Right', textAlign: 'right', italic: true },
      ],
    };
    const host = render(createElement(RichCell, { cell: value }));
    expect(host.textContent).toBe(value.plain);
    expect(
      [...host.querySelectorAll<HTMLElement>('[style*="text-align"]')].map(
        (el) => el.style.textAlign,
      ),
    ).toEqual(['center', 'center', 'right']);
  });
  it('keeps diff words inline inside aligned lines and updates all mounted comparisons', () => {
    const props = { before: aligned('One\nold'), after: aligned('One\nnew', 'right') };
    const host = render(
      createElement(
        'div',
        null,
        createElement(CompendiumDiff, props),
        createElement(CompendiumDiff, props),
      ),
    );
    expect(host.querySelector('ins [data-multiline]')?.textContent).toBe('new');
    expect(host.querySelector<HTMLElement>('[style*="text-align"]')?.style.textAlign).toBe('right');
    const button = [...host.querySelectorAll('button')].find(
      (el) => el.textContent === 'Before / After',
    )!;
    act(() => button.click());
    expect(host.querySelectorAll('h4')).toHaveLength(4);
    expect(
      [...host.querySelectorAll('button[aria-pressed="true"]')].every(
        (el) => el.textContent === 'Before / After',
      ),
    ).toBe(true);
    act(() =>
      [...host.querySelectorAll('button')].find((el) => el.textContent === 'Changes')!.click(),
    );
    expect(host.querySelectorAll('h4')).toHaveLength(0);
  });
  it('remembers the choice after reload without creating synced changes', () => {
    const { storage, values } = memoryStorage();
    const store = createSettingsStore({ storage, syncEnabled: false });
    store.getState().remember({ compendiumDiff: 'before-after' });
    expect(JSON.parse(values.get(deviceKey)!).remembered.compendiumDiff).toBe('before-after');
    expect(
      createSettingsStore({ storage, syncEnabled: false }).getState().device.remembered
        .compendiumDiff,
    ).toBe('before-after');
    expect(store.getState().pending).toEqual([]);
  });
});
