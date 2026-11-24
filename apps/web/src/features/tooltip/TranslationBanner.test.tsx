// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { editorData, english } from '../../services/save/fixtures.testSupport';
import { TranslationBanner } from './TranslationBanner';

it('shows the pending History restore without offering to confirm the already-current saved text', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const saved: Tooltip = {
    hash: 123,
    associated: [],
    text: { en: english, de: { ...english, text: 'Deutsch.', sourceUpdatedAt: english.updatedAt } },
  };
  const sourceUpdatedAt = '2020-01-01T00:00:00.000Z';
  const onConfirm = vi.fn();
  const data = editorData();
  try {
    await act(async () =>
      root.render(
        <TranslationBanner
          saved={saved}
          base={saved}
          next={saved}
          lang="de"
          data={data}
          suspended={false}
          translationRevisions={{ de: { commit: 'a'.repeat(40), sourceUpdatedAt, restore: true } }}
          onConfirm={onConfirm}
        />,
      ),
    );
    expect(host.querySelector('[data-level="published"]')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
