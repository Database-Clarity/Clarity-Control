import { describe, expect, it } from 'vitest';
import {
  countConflicts,
  findConflictBlocks,
  hasConflictMarkers,
  maskConflicts,
  mergeTextWithMarkers,
  resolveConflictBlock,
  resolveConflictMarkers,
  writeConflictMarkers,
} from './conflicts.js';

function applyFirst(text: string, choice: 'mine' | 'theirs' | 'both') {
  const [block] = findConflictBlocks(text);
  const edit = resolveConflictBlock(text, block!, choice);
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

describe('conflict markers', () => {
  it('round-trips one block through write and find', () => {
    const block = writeConflictMarkers(['a', 'b'], ['c'], '(alice, 2026-11-03 18:02)');
    const text = `top\n${block}\nbottom`;
    const [found] = findConflictBlocks(text);
    expect(found).toMatchObject({
      mineLines: ['a', 'b'],
      theirsLines: ['c'],
      label: '(alice, 2026-11-03 18:02)',
    });
    expect(text.slice(found!.from, found!.to)).toBe(block);
    expect(text.slice(found!.from, found!.openEnd)).toBe('<<<<<<< mine');
    expect(hasConflictMarkers(text)).toBe(true);
    expect(countConflicts(text)).toBe(1);
  });

  it('resolves mine, theirs and both, keeping the lines around the block', () => {
    const text = `top\n${writeConflictMarkers(['m1', 'm2'], ['t1'])}\nbottom`;
    expect(applyFirst(text, 'mine')).toBe('top\nm1\nm2\nbottom');
    expect(applyFirst(text, 'theirs')).toBe('top\nt1\nbottom');
    expect(applyFirst(text, 'both')).toBe('top\nm1\nm2\nt1\nbottom');
  });

  it('removes the block and one line break when a side has no lines', () => {
    const text = `top\n${writeConflictMarkers([], ['t1'])}\nbottom`;
    expect(applyFirst(text, 'mine')).toBe('top\nbottom');
    expect(applyFirst(`${writeConflictMarkers([], ['t1'])}\nbottom`, 'mine')).toBe('bottom');
    expect(applyFirst(`top\n${writeConflictMarkers([], ['t1'])}`, 'mine')).toBe('top');
    expect(applyFirst(writeConflictMarkers([], ['t1']), 'mine')).toBe('');
    // A blank line is a line: resolving to it keeps it.
    expect(applyFirst(`top\n${writeConflictMarkers([''], ['t1'])}\nbottom`, 'mine')).toBe(
      'top\n\nbottom',
    );
  });

  it('finds adjacent blocks separately and resolves them one by one', () => {
    const a = writeConflictMarkers(['a1'], ['a2']);
    const b = writeConflictMarkers(['b1'], ['b2']);
    const text = `${a}\n${b}`;
    expect(findConflictBlocks(text)).toHaveLength(2);
    const once = applyFirst(text, 'theirs');
    expect(once).toBe(`a2\n${b}`);
    expect(findConflictBlocks(once)).toHaveLength(1);
    expect(resolveConflictMarkers(text, 'mine')).toBe('a1\nb1');
    expect(resolveConflictMarkers(text, 'theirs')).toBe('a2\nb2');
    expect(resolveConflictMarkers(text, 'both')).toBe('a1\na2\nb1\nb2');
  });

  it('keeps CRLF documents CRLF', () => {
    const text = `top\r\n${writeConflictMarkers(['m1'], ['t1', 't2'], '', '\r\n')}\r\nbottom`;
    const [block] = findConflictBlocks(text);
    expect(block!.mineLines).toEqual(['m1']);
    expect(block!.theirsLines).toEqual(['t1', 't2']);
    expect(applyFirst(text, 'both')).toBe('top\r\nm1\r\nt1\r\nt2\r\nbottom');
    expect(applyFirst(text, 'theirs')).toBe('top\r\nt1\r\nt2\r\nbottom');
    expect(resolveConflictMarkers(text)).toBe('top\r\nm1\r\nbottom');
  });

  it('treats a hand-damaged marker as still unresolved, never as clean text', () => {
    const block = writeConflictMarkers(['m'], ['t']);
    const noClose = block.replace(/>>>>>>>.*$/, '');
    const noOpen = block.replace('<<<<<<< mine', '');
    expect(findConflictBlocks(noClose)).toHaveLength(0);
    expect(hasConflictMarkers(noOpen)).toBe(true);
    expect(hasConflictMarkers(noClose)).toBe(true);
    expect(countConflicts(noClose)).toBe(1);
    // An ordinary separator-like line is not a conflict.
    expect(hasConflictMarkers('Title\n=======\ntext')).toBe(false);
    expect(hasConflictMarkers('a <<<<<<< b')).toBe(false);
    expect(hasConflictMarkers('')).toBe(false);
    // A second opening marker abandons the unfinished one.
    const nested = `<<<<<<< mine\nx\n${block}`;
    expect(findConflictBlocks(nested)).toHaveLength(1);
    expect(hasConflictMarkers(nested)).toBe(true);
  });

  it('masks markers and "theirs" without moving any offset', () => {
    const text = `top\n${writeConflictMarkers(['mine line'], ['their line'], '(bob)')}\nbottom`;
    const masked = maskConflicts(text);
    expect(masked).toHaveLength(text.length);
    expect(
      masked
        .replace(/ +/g, ' ')
        .split('\n')
        .map((line) => line.trim()),
    ).toEqual(['top', '', 'mine line', '', '', '', 'bottom']);
    expect(masked.indexOf('mine line')).toBe(text.indexOf('mine line'));
    expect(maskConflicts('plain')).toBe('plain');
  });
});

describe('mergeTextWithMarkers', () => {
  it('takes changes only one side made, without markers', () => {
    const base = 'one\ntwo\nthree\nfour';
    const merged = mergeTextWithMarkers(base, 'ONE\ntwo\nthree\nfour', 'one\ntwo\nthree\nFOUR');
    expect(merged).toEqual({ text: 'ONE\ntwo\nthree\nFOUR', conflicts: 0 });
  });

  it('takes an identical change once', () => {
    expect(mergeTextWithMarkers('a\nb', 'a\nX', 'a\nX')).toEqual({ text: 'a\nX', conflicts: 0 });
  });

  it('marks only the lines both sides changed differently', () => {
    const base = 'head\nshared\ntail';
    const merged = mergeTextWithMarkers(base, 'head\nmine\ntail', 'head\ntheirs\ntail', '(bob)');
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      'head\n<<<<<<< mine\nmine\n=======\ntheirs\n>>>>>>> theirs (bob)\ntail',
    );
    expect(resolveConflictMarkers(merged.text, 'mine')).toBe('head\nmine\ntail');
    expect(resolveConflictMarkers(merged.text, 'theirs')).toBe('head\ntheirs\ntail');
  });

  it('keeps clean changes around a conflict and counts several conflicts', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const merged = mergeTextWithMarkers(base, 'a\nB1\nc\nd\ne\nF1\ng', 'a\nB2\nc\nD2\ne\nF2\ng');
    // b conflicts; d only they changed; f conflicts.
    expect(merged.conflicts).toBe(2);
    expect(resolveConflictMarkers(merged.text, 'mine')).toBe('a\nB1\nc\nD2\ne\nF1\ng');
    expect(resolveConflictMarkers(merged.text, 'theirs')).toBe('a\nB2\nc\nD2\ne\nF2\ng');
  });

  it('treats touching changes as one conflict, like git', () => {
    const merged = mergeTextWithMarkers('a\nb\nc', 'a\nB\nc', 'a\nb\nC');
    expect(merged.conflicts).toBe(1);
    expect(resolveConflictMarkers(merged.text, 'both')).toBe('a\nB\nc\nb\nC');
  });

  it('handles insertions at the same place, deletions and an empty base', () => {
    expect(mergeTextWithMarkers('a\nc', 'a\nm\nc', 'a\nt\nc').conflicts).toBe(1);
    expect(mergeTextWithMarkers('a\nb\nc', 'a\nc', 'a\nb\nc\nd')).toEqual({
      text: 'a\nc\nd',
      conflicts: 0,
    });
    const fresh = mergeTextWithMarkers('', 'mine', 'theirs');
    expect(fresh.conflicts).toBe(1);
    expect(resolveConflictMarkers(fresh.text, 'theirs')).toBe('theirs');
    expect(mergeTextWithMarkers('', 'same', 'same')).toEqual({ text: 'same', conflicts: 0 });
  });

  it('writes CRLF markers into CRLF text', () => {
    const merged = mergeTextWithMarkers('a\r\nb', 'a\r\nM', 'a\r\nT');
    expect(merged.text).toBe('a\r\n<<<<<<< mine\r\nM\r\n=======\r\nT\r\n>>>>>>> theirs');
    expect(merged.text).not.toMatch(/(?<!\r)\n/);
  });

  it('falls back to one whole-text block when the inputs are too big to compare', () => {
    const lines = (prefix: string) => Array.from({ length: 2500 }, (_, i) => `${prefix}${i}`);
    const merged = mergeTextWithMarkers('', lines('m').join('\n'), lines('t').join('\n'));
    expect(merged.conflicts).toBe(1);
    expect(findConflictBlocks(merged.text)).toHaveLength(1);
  });
});
