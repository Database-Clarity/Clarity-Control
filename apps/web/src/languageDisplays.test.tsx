// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { IdentityStatus } from './features/auth/AuthStatus';
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
