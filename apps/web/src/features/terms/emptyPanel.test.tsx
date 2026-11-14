// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ClarityEditor } from '../editor/ClarityEditor';
import { useAuthStore } from '../../stores/auth';
import { useGlossaryStore } from '../../stores/glossary';

vi.mock('./useTooltipTerms', () => ({
  useTooltipTerms: () => ({ loading: false, terms: [], check: undefined }),
}));
it('opens an empty Terms panel from the status item and exposes Add term', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' } });
  useGlossaryStore.setState({
    byLang: { de: { remote: { revision: null, glossary: { v: 1, lang: 'de', terms: {} } } } },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ClarityEditor
          value="Deutsch"
          lang="de"
          sourceText="No known words."
          terms
          globals={{ variables: '', titles: '' }}
          tooltipHash={10}
          onChange={() => {}}
        />,
      ),
    );
    const button = host.querySelector<HTMLButtonElement>('[data-status-terms]')!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    const panel = host.querySelector('#editor-panel-terms');
    expect(panel?.textContent).toContain('No terms in this tooltip yet.');
    expect(
      [...panel!.querySelectorAll('button')].some((button) => button.textContent === 'Add term'),
    ).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useAuthStore.setState({ user: null, token: null });
  }
});
