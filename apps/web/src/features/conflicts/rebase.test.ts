import { describe, expect, it } from 'vitest';
import { findConflictBlocks, resolveConflictMarkers, type Tooltip } from '@clarity/core';
import type { SaveConflict } from '../../services/api';
import type { Drafts } from '../../services/draftStorage';
import { rebaseConflict, reconcileDrafts, theirsLabel } from './rebase';

const entry = (text: string, by = 'author') => ({
  text,
  updatedAt: '2026-01-01T10:00:00.000Z',
  updatedBy: by,
});
const tooltip = (en: string, extra: Partial<Tooltip> = {}): Tooltip => ({
  hash: 10,
  text: { en: entry(en) },
  associated: [],
  ...extra,
});
const conflict = (base: Tooltip, head: Tooltip, next: Tooltip, fields: string[]): SaveConflict => ({
  hash: 10,
  base,
  head,
  next,
  fields,
});

describe('rebaseConflict', () => {
  const base = tooltip('top\nshared\nbottom');
  const head = tooltip('top\ntheirs\nbottom', { associated: [7] });
  const next = tooltip('top\nmine\nbottom');

  it('rebases on the server version, writes a block and keeps their other changes', () => {
    const result = rebaseConflict(conflict(base, head, next, ['text.en']))!;
    expect(result.base).toEqual(head);
    expect(result.markers).toBe(1);
    expect(result.markerLanguages).toEqual(['en']);
    expect(result.next.associated).toEqual([7]);
    const text = result.next.text.en!.text;
    expect(findConflictBlocks(text)).toHaveLength(1);
    expect(text).toContain('>>>>>>> theirs (author, 2026-01-01');
    expect(resolveConflictMarkers(text, 'mine')).toBe('top\nmine\nbottom');
    expect(resolveConflictMarkers(text, 'theirs')).toBe('top\ntheirs\nbottom');
    // My entry's metadata stays mine.
    expect(result.next.text.en!.updatedBy).toBe('author');
  });

  it('merges a text both sides changed on different lines without any marker', () => {
    const result = rebaseConflict(
      conflict(tooltip('a\nb\nc\nd\ne'), tooltip('A\nb\nc\nd\ne'), tooltip('a\nb\nc\nd\nE'), [
        'text.en',
      ]),
    )!;
    expect(result.markers).toBe(0);
    expect(result.mergedLanguages).toEqual(['en']);
    expect(result.next.text.en!.text).toBe('A\nb\nc\nd\nE');
  });

  it('keeps my value for a non-text field and lists it as a row', () => {
    const mine = { name: 'Mine', categoryId: 'perk' };
    const result = rebaseConflict(
      conflict(
        tooltip('x', { custom: { name: 'Base', categoryId: 'perk' } }),
        tooltip('x', { custom: { name: 'Theirs', categoryId: 'perk' } }),
        tooltip('x', { custom: mine }),
        ['custom'],
      ),
    )!;
    expect(result.rows).toEqual(['custom']);
    expect(result.markers).toBe(0);
    expect(result.next.custom).toEqual(mine);
  });

  it('handles several languages and a language I removed', () => {
    const result = rebaseConflict(
      conflict(
        { ...base, text: { en: entry('one'), fr: entry('un') } },
        { ...base, text: { en: entry('two'), fr: entry('deux') } },
        { ...base, text: { en: entry('three') } },
        ['text.en', 'text.fr'],
      ),
    )!;
    // French: I removed it, they changed it. Mine is empty on one side of the block.
    expect([...result.markerLanguages].sort()).toEqual(['en', 'fr']);
    expect(findConflictBlocks(result.next.text.fr!.text)[0]!.mineLines).toEqual(['']);
    expect(result.next.text.fr!.updatedBy).toBe('author');
  });

  it('is not for $exists', () => {
    expect(rebaseConflict({ ...conflict(base, head, next, ['$exists']), head: null })).toBeNull();
  });

  it('labels theirs with author and local time, never a line break', () => {
    expect(theirsLabel(undefined)).toBe('');
    expect(theirsLabel(entry('x', 'ali\nce'))).toMatch(/^\(ali ce, \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
  });
});

describe('reconcileDrafts (Reload after another tab wrote)', () => {
  const draft = (en: string, extra: Partial<Tooltip> = {}) => ({
    base: tooltip('base'),
    next: tooltip(en, extra),
  });
  const drafts = (...values: [string, ReturnType<typeof draft>][]): Drafts =>
    Object.fromEntries(values);

  it('takes whichever side changed, and keeps both when different tooltips changed', () => {
    const ancestor = drafts(['10', draft('a')]);
    expect(reconcileDrafts(ancestor, ancestor, drafts(['10', draft('b')]))).toEqual(
      drafts(['10', draft('b')]),
    );
    expect(reconcileDrafts(ancestor, drafts(['10', draft('c')]), ancestor)).toEqual(
      drafts(['10', draft('c')]),
    );
    const other = {
      base: { ...tooltip('b'), hash: 11 },
      next: { ...tooltip('x'), hash: 11 },
    };
    const merged = reconcileDrafts(ancestor, ancestor, { ...ancestor, 11: other });
    expect(Object.keys(merged).sort()).toEqual(['10', '11']);
  });

  it('never drops a draft one side still has', () => {
    const ancestor = drafts(['10', draft('a')]);
    // The other tab discarded it; I edited it meanwhile: mine stays.
    expect(reconcileDrafts(ancestor, drafts(['10', draft('mine')]), {})).toEqual(
      drafts(['10', draft('mine')]),
    );
    // I discarded it; the other tab edited it: theirs stays.
    expect(reconcileDrafts(ancestor, {}, drafts(['10', draft('theirs')]))).toEqual(
      drafts(['10', draft('theirs')]),
    );
  });

  it('merges edits of the same tooltip: clean lines together, same lines as a block', () => {
    const ancestor = drafts(['10', draft('one\ntwo\nthree\nfour\nfive')]);
    const clean = reconcileDrafts(
      ancestor,
      drafts(['10', draft('ONE\ntwo\nthree\nfour\nfive')]),
      drafts(['10', draft('one\ntwo\nthree\nfour\nFIVE')]),
    );
    expect(clean['10']!.next.text.en!.text).toBe('ONE\ntwo\nthree\nfour\nFIVE');
    const clash = reconcileDrafts(
      ancestor,
      drafts(['10', draft('one\nMINE\nthree\nfour\nfive')]),
      drafts(['10', draft('one\nTHEIRS\nthree\nfour\nfive')]),
    );
    const text = clash['10']!.next.text.en!.text;
    expect(findConflictBlocks(text)).toHaveLength(1);
    expect(text).toContain('(other tab)');
    expect(resolveConflictMarkers(text, 'mine')).toContain('MINE');
  });

  it('keeps my resolved parts: a resolved block does not come back from the other tab', () => {
    const marked = 'a\n<<<<<<< mine\nm\n=======\nt\n>>>>>>> theirs\nb';
    const ancestor = drafts(['10', draft(marked)]);
    // I resolved to "m"; the other tab only appended a line below.
    const merged = reconcileDrafts(
      ancestor,
      drafts(['10', draft('a\nm\nb')]),
      drafts(['10', draft(`${marked}\nc`)]),
    );
    expect(merged['10']!.next.text.en!.text).toBe('a\nm\nb\nc');
  });
});
