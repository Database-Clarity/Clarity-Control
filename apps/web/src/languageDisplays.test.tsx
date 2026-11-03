import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { IdentityStatus } from './features/auth/AuthStatus';
import { GlobalDetailPage } from './features/globals/GlobalsPage';
import { SaveSummary } from './services/save/SaveSummary';
import type { EditorData } from './stores/data';
import type { TooltipValidationIssue } from '@clarity/core';

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
      name: 'foo',
      definitions: { de: 'value' },
      usages: [
        { hash: 10, lang: 'de', line: 1, source: '#foo' },
        { hash: 11, lang: 'xx', line: 2, source: '#foo' },
      ],
    },
  ],
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
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/globals/:kind/:name',
          element: createElement(GlobalDetailPage),
        }),
      ),
    ),
  );
  expect(html).toContain('German / line 1');
  expect(html).toContain('xx / line 2');
  expect(html).toContain('?lang=de&amp;line=1&amp;variant=10');
});
