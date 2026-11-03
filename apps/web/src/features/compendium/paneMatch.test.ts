import { describe, expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { paneMatch } from './paneMatch';
import { emptyProgress } from './reviewProgress';

describe('pane matcher evidence gates', () => {
  function fixture() {
    const f = guidedFixture();
    const base = f.categories[0].entries.find((entry) => entry.hash === 100)!.base;
    return { ...f, base };
  }
  it('shows current owner-approved HIGH results and never mutates editor data', () => {
    const f = fixture();
    const before = JSON.stringify(f.editor);
    expect(
      paneMatch(f.base, f.editor, f.source, {}, emptyProgress(), f.document, f.scope)?.row.name,
    ).toBe('Sample 100');
    expect(JSON.stringify(f.editor)).toBe(before);
  });
  it('withholds stale baseline, changed evidence, and excluded or unresolved outcomes', () => {
    const f = fixture();
    expect(
      paneMatch(
        f.base,
        f.editor,
        f.source,
        {},
        emptyProgress(),
        { ...f.document, baseline: 'stale' },
        f.scope,
      ),
    ).toBeUndefined();
    f.document.categories[f.categories[0].id].references![100].evidence = 'changed';
    expect(
      paneMatch(f.base, f.editor, f.source, {}, emptyProgress(), f.document, f.scope),
    ).toBeUndefined();
    for (const hash of [103, 104, 105]) {
      const base = f.categories[0].entries.find((entry) => entry.hash === hash)!.base;
      expect(
        paneMatch(base, f.editor, f.source, {}, emptyProgress(), f.document, f.scope),
      ).toBeUndefined();
    }
  });
  it('keeps existing links ahead of matching, including explicit unlink drafts', () => {
    const f = fixture();
    const link = f.proposals.get(100)!.link!;
    const saved = { ...f.base, compendium: link };
    expect(
      paneMatch(saved, f.editor, f.source, {}, emptyProgress(), f.document, f.scope),
    ).toBeUndefined();
    expect(
      paneMatch(
        f.base,
        f.editor,
        f.source,
        { 100: { base: f.base, next: saved } },
        emptyProgress(),
        f.document,
        f.scope,
      ),
    ).toBeUndefined();
    expect(
      paneMatch(
        saved,
        f.editor,
        f.source,
        { 100: { base: saved, next: f.base } },
        emptyProgress(),
        f.document,
        f.scope,
      ),
    ).toBeUndefined();
  });
});
