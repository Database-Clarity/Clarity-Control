// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPreview } from './TooltipPreview';
import { previewNumberGlobals } from '../../services/tooltipImports';

it('renders token values with locale formatting and preserves the token-free DOM exactly', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const globals = { variables: '', titles: '' };
  const source: Tooltip = {
    hash: 7,
    associated: [],
    text: {
      en: {
        text: 'Lasts 4.5 seconds.',
        updatedAt: '2026-11-15T00:00:00Z',
        updatedBy: 'editor',
      },
    },
  };
  try {
    await act(async () =>
      root.render(
        <TooltipPreview name="Example" text="Literal 4.5." lang="de" globals={globals} />,
      ),
    );
    const original = host.innerHTML;
    const input = previewNumberGlobals(source, 'de', globals);
    await act(async () =>
      root.render(<TooltipPreview name="Example" text="Literal 4.5." lang="de" globals={input} />),
    );
    expect(host.innerHTML).toBe(original);
    await act(async () =>
      root.render(
        <TooltipPreview name="Example" text="Dauert #{=1} Sekunden." lang="de" globals={input} />,
      ),
    );
    expect(host.textContent).toContain('Dauert 4,5 Sekunden.');
    expect(host.textContent).not.toContain('#{=');
  } finally {
    await act(async () => root.unmount());
  }
});
