// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceRef } from './SourceRef';
import { linkLocation, sourceHref } from './sourceLocation';

const location = {
  tab: 'Armor Mods',
  section: 'Raid Specific',
  range: 'C12:E14, A20',
  gid: '77',
  label: 'Armor Mods · Raid Specific · C12:E14, A20',
  href: sourceHref('77', 'C12:E14'),
};

// The separators carry non-breaking spaces; compare plain text.
const text = (node: Element) => node.textContent!.split(String.fromCharCode(160)).join(' ');

function link(element: React.ReactElement) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host.querySelector('a')!;
}

describe('SourceRef', () => {
  it('links the full label into the sheet in a new tab', () => {
    const a = link(<SourceRef location={location} />);
    expect(text(a)).toContain('Armor Mods · Raid Specific · C12:E14, A20');
    expect(a.getAttribute('href')).toBe(location.href);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('keeps the full label in the title when it shows the tab only', () => {
    const a = link(<SourceRef location={location} show="tab" />);
    expect(a.querySelector('[aria-hidden], span')?.textContent).toBe('Armor Mods');
    expect(a.title).toContain(location.label);
  });

  it('says plainly when the position is unknown', () => {
    const a = link(<SourceRef location={linkLocation({ gid: '77' }, null)} />);
    expect(text(a)).toContain('Sheet tab · position unknown');
    expect(a.textContent).not.toContain('77');
    expect(a.getAttribute('href')).toBe(sourceHref('77'));
  });

  it('names the first of many regions and how many follow, never cutting an address', () => {
    const range = ['D36:M36', 'N35:N36', 'D40:M40', 'N39:N40', 'D44:M44'].join(', ');
    const many = { ...location, range, label: `Arc · ${range}` };
    const a = link(<SourceRef location={many} />);
    expect(text(a)).toContain('D36:M36 +4 more');
    expect(a.title).toContain(range);
    expect(a.querySelector('.sr-only')!.textContent).toContain(range);
  });
});
