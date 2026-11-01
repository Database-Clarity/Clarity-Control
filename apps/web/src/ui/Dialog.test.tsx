import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';

function render(props: { footer?: ReactNode; busy?: boolean }) {
  return renderToStaticMarkup(
    createElement(Dialog, {
      title: 'Review',
      onClose: () => undefined,
      ...props,
      children: createElement('p', null, 'Body text'),
    }),
  );
}

describe('Dialog', () => {
  it('renders header, body and the footer slot in that order', () => {
    const html = render({ footer: createElement('button', { type: 'button' }, 'Save') });
    expect(html).toMatch(/<header[^>]*><h2>Review<\/h2><button[^>]*>Close<\/button><\/header>/);
    const header = html.indexOf('<header');
    const body = html.indexOf('Body text');
    const footer = html.indexOf('<footer');
    expect(header).toBeLessThan(body);
    expect(body).toBeLessThan(footer);
    expect(html).toMatch(/<footer[^>]*><button type="button">Save<\/button><\/footer>/);
    expect(html.endsWith('</footer></dialog>')).toBe(true);
  });

  it('omits the footer when no slot content is given', () => {
    const html = render({});
    expect(html).toContain('Body text');
    expect(html).not.toContain('<footer');
  });

  it('keeps the close button and aria-label for existing consumers', () => {
    const html = render({ busy: true });
    expect(html).toContain('aria-label="Review"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Close dialog"/);
  });
});
