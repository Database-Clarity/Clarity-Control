// @vitest-environment jsdom
// The pane skeleton reserves the rows its loaded pane will show (U25): the narrow-pane view
// switch for every comparison, and the diff legend only when the cells differ.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompendiumCell, Tooltip } from '@clarity/core';
import { CompendiumPaneSkeleton, rememberPaneSkeleton } from './CompendiumPaneSkeleton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cell = (text: string): CompendiumCell => ({ plain: text, runs: [{ text }] });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function render(
  props: Partial<Parameters<typeof CompendiumPaneSkeleton>[0]> & { hash: number },
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const { hash, ...rest } = props;
  await act(async () =>
    root.render(
      createElement(CompendiumPaneSkeleton, {
        base: { hash, text: {}, associated: [] } as unknown as Tooltip,
        link: undefined,
        draft: false,
        sourceFetchedAt: '2026-11-01T00:00:00Z',
        width: 384,
        scale: 100,
        remPx: 16,
        mode: 'changes',
        phone: false,
        canEdit: true,
        canReview: true,
        roomy: false,
        diffControl: createElement('span', { 'data-switch': true }),
        ...rest,
      }),
    ),
  );
  return host;
}
const legend = (host: HTMLElement) => host.querySelector('[class*="key"]');
const viewSwitch = (host: HTMLElement) => host.querySelector('[data-switch]');

describe('Compendium pane skeleton', () => {
  it('reserves the view switch for an unvisited match with approval evidence', async () => {
    const host = await render({ hash: 101, after: cell('Current'), expectComparison: true });
    expect(viewSwitch(host)).not.toBeNull();
    // Whether the cells differ is unknown before the row is compared: no legend guessed.
    expect(legend(host)).toBeNull();
  });

  it('shows the legend when the known cells differ, and not when they match', async () => {
    const differ = await render({ hash: 102, before: cell('Old'), after: cell('New') });
    expect(viewSwitch(differ)).not.toBeNull();
    expect(legend(differ)).not.toBeNull();
    const same = await render({ hash: 103, before: cell('Same'), after: cell('Same') });
    expect(viewSwitch(same)).not.toBeNull();
    expect(legend(same)).toBeNull();
  });

  it('remembers whether a painted entry differed', async () => {
    rememberPaneSkeleton(104, '2026-11-01T00:00:00Z', cell('Old'), cell('New'));
    rememberPaneSkeleton(105, '2026-11-01T00:00:00Z', cell('Same'), cell('Same'));
    expect(legend(await render({ hash: 104 }))).not.toBeNull();
    expect(legend(await render({ hash: 105 }))).toBeNull();
  });

  it('keeps the switch in the header when the pane is roomy', async () => {
    const host = await render({
      hash: 106,
      after: cell('Current'),
      expectComparison: true,
      roomy: true,
    });
    expect(viewSwitch(host)).toBeNull();
  });
});
