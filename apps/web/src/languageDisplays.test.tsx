// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { IdentityStatus } from './features/auth/AuthStatus';
import { GlobalDetailPage, GlobalUsages } from './features/globals/GlobalsPage';
import { SaveSummary } from './services/save/SaveSummary';
import type { EditorData } from './stores/data';
import type { TooltipValidationIssue } from '@clarity/core';

const references = vi.hoisted(() => [
  { hash: 10, lang: 'de', line: 1, source: '#foo' },
  { hash: 11, lang: 'xx', line: 2, source: '#foo' },
]);

vi.mock('./services/api', () => ({ apiUrl: 'https://example.test', loginUrl: () => '/' }));
vi.mock('./stores/auth', () => ({
  useAuthStore: () => ({
    user: { login: 'a', role: 'translator', languages: ['de', 'fr', 'xx'] },
    loading: false,
    load: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock('./stores/data', () => ({
  useDataStore: (selector: (state: { data: null }) => unknown) => selector({ data: null }),
}));
vi.mock('./features/globals/useGlobals', () => ({
  useGlobals: () => [
    {
      kind: 'variables',
      hash: 2,
      name: 'foo',
      definitions: { de: 'value' },
      usages: references,
    },
  ],
  useGlobalUsages: () => references,
}));

it('shows friendly assigned languages and preserves unknown codes', () => {
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(IdentityStatus, {})),
  );
  expect(html).toContain('German, French, xx');
});
it('labels validation languages', () => {
  const issues = [
    { severity: 'warning', hash: 10, lang: 'de', message: 'Example warning' },
    { severity: 'warning', hash: 11, lang: 'xx', message: 'Unknown' },
  ] as TooltipValidationIssue[];
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(SaveSummary, { changes: [], issues, data: {} as EditorData }),
    ),
  );
  expect(html).toContain('German: Example warning');
  expect(html).toContain('xx: Unknown');
});
it('labels global references while keeping language codes in URLs', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/globals/variables/foo'] },
      createElement(GlobalUsages, { hash: 2, name: 'foo' }),
    ),
  );
  expect(html).toContain('German · line 1');
  expect(html).toContain('xx · line 2');
  expect(html).toContain('?lang=de&amp;line=1&amp;variant=10');
  expect(html).toContain('?lang=xx&amp;line=2&amp;variant=11');
});

it('redirects legacy global detail links to their aggregate declaration workspace', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Location() {
    const { pathname, search } = useLocation();
    return (
      <output>
        {pathname}
        {search}
      </output>
    );
  }
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/globals/variables/foo']}>
          <Routes>
            <Route path="/globals/:kind/:name" element={<GlobalDetailPage />} />
            <Route path="/t/:hash" element={<Location />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector('output')?.textContent).toBe('/t/2?global=foo');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
