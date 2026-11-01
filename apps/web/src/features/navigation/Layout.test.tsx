import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { AuthStatus } from '../auth/AuthStatus';
import styles from './Layout.module.scss';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: ({ className }: { className?: string }) =>
    createElement('section', { 'data-save-panel': '', className }),
}));

function render(element: ReturnType<typeof createElement>, location = '/') {
  return renderToStaticMarkup(createElement(StaticRouter, { location }, element));
}
function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

describe('Layout phone shell', () => {
  const html = render(createElement(Layout));

  it('renders a closed Browse toggle controlling the sidebar', () => {
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Browse<\/button>/);
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`<aside id="${controls}"`);
    expect(html).toContain('data-open="false"');
  });

  it('renders the save panel exactly once, after the identity, inside the sidebar', () => {
    expect(count(html, 'data-save-panel')).toBe(1);
    expect(html.indexOf('data-save-panel')).toBeGreaterThan(html.indexOf('<aside'));
    expect(html.indexOf('data-save-panel')).toBeLessThan(html.indexOf('</aside>'));
  });

  it('keeps the skip link', () => {
    expect(html).toContain('href="#main-content"');
  });

  it('applies review mode only to the Compendium review route', () => {
    expect(render(createElement(Layout), '/compendium/review')).toContain(styles.reviewMode);
    expect(html).not.toContain(styles.reviewMode);
  });
});

describe('AuthStatus', () => {
  it('no longer contains the save section', () => {
    const html = render(createElement(AuthStatus));
    expect(html).not.toContain('data-save-panel');
    expect(html).not.toContain('Save drafts');
  });
});
