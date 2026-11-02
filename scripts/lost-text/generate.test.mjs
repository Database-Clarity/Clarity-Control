import { describe, expect, it } from 'vitest';
import { classify } from './generate.mjs';

describe('lost-text authorship evidence', () => {
  it('never treats tracker zero alone as human', () => {
    expect(
      classify('Useful text', { lastUpdate: 0, updatedBy: 'someone' }, 'Other').classification,
    ).toBe('unclear');
  });
  it('hides normalized manifest copies and placeholders', () => {
    expect(classify('Some  text\n', { lastUpdate: 0 }, 'Some text').classification).toBe(
      'manifest-copy',
    );
    expect(classify('// todo\nimport self', { lastUpdate: 12 }).classification).toBe('placeholder');
  });
  it('uses historical snapshots before human evidence', () => {
    expect(
      classify('Exact text', { updatedBy: 'editor', v2: true }, 'New text', 'Exact text')
        .classification,
    ).toBe('manifest-copy');
    expect(
      classify('Authored text', { updatedBy: 'editor', v2: true }, 'Other').classification,
    ).toBe('human');
  });
  it('keeps authored current-manifest matches uncertain without historical evidence', () => {
    expect(classify('Exact text', { lastUpdate: 100 }, 'Exact text').classification).toBe(
      'unclear',
    );
  });
});
