// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { CompendiumCell } from '@clarity/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Multiline, RichCell } from './RichCell';
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
