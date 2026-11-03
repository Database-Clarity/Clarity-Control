import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import styles from './Layout.module.scss';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => createElement('div', { 'data-save-controller': '' }),
}));

function render(element: ReturnType<typeof createElement>, location = '/') {
  return renderToStaticMarkup(createElement(StaticRouter, { location }, element));
}
function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

describe('Layout desktop shell', () => {
  const html = render(createElement(Layout));

  it('renders the header with the brand, workspace tabs, drafts and the account, and no Browse drawer', () => {
    expect(html).toContain('<header');
    expect(html).toContain('alt="Clarity Control"');
    expect(html).toContain('aria-label="Workspaces"');
    expect(html).toContain('data-drafts-button');
    expect(html).toContain('data-identity-button');
    expect(html).not.toContain('Browse');
    expect(html).not.toContain('id="sidebar"');
    expect(html).not.toContain('Review and save drafts');
  });

  it('mounts the save session controller exactly once, outside the inert-able shell root', () => {
    expect(count(html, 'data-save-controller')).toBe(1);
    expect(html.indexOf('data-save-controller')).toBeGreaterThan(html.indexOf('id="shell-root"'));
    expect(html.indexOf('data-save-controller')).toBeGreaterThan(html.indexOf('</main>'));
  });

  it('keeps the skip link and the main target', () => {
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
  });

  it('applies review mode across the Compendium workspace and shows its context column', () => {
    const compendium = render(createElement(Layout), '/compendium');
    expect(compendium).toContain(styles.reviewMode);
    expect(compendium).toContain('aria-label="Context"');
    expect(render(createElement(Layout), '/compendium/review')).toContain(styles.reviewMode);
    expect(html).not.toContain(styles.reviewMode);
    expect(html).not.toContain('aria-label="Context"');
  });
});
