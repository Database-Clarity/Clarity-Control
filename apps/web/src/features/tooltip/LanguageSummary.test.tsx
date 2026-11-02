import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { languageLabel } from '../../languageLabels';
import { LanguageSummary } from './LanguageSummary';
import type { Tooltip } from '@clarity/core';

describe('language presentation', () => {
  it('names known languages and preserves unknown codes', () => {
    expect(languageLabel('zh-chs')).toBe('Chinese (Simplified)');
    expect(languageLabel('other')).toBe('other');
    expect(languageLabel('')).toBe('Unknown language');
  });
  it('distinguishes saved metadata, missing metadata, and unsaved text', () => {
    const base: Tooltip = {
      hash: 1,
      associated: [],
      text: { en: { text: 'x', updatedAt: '1970-01-01T00:00:00.000Z', updatedBy: '' } },
    };
    const html = renderToStaticMarkup(<LanguageSummary base={base} lang="en" draft />);
    expect(html).toContain('Local draft');
    expect(html).toContain('unknown author, unknown time');
    expect(html).toContain('<details>');
    expect(html).toContain('Legacy tooltip upload');
    expect(renderToStaticMarkup(<LanguageSummary base={base} lang="fr" draft={false} />)).toContain(
      'No saved language text',
    );
  });
});
