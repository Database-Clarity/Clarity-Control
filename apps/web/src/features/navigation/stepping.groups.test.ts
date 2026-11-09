import { describe, expect, it } from 'vitest';
import {
  parseScope,
  resolvePlace,
  scopeValue,
  stepTarget,
  tooltipPath,
  wheelStep,
  type Entry,
} from './stepping';

const wheel = (init: Partial<Parameters<typeof wheelStep>[0]> = {}) => ({
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  deltaX: 0,
  deltaY: 100,
  ...init,
});
// 101 is listed under Dead Messenger (1001) and Hard Light (1002); its first owner is 1001.
const firstGroup = new Map([
  [100, '1001'],
  [101, '1001'],
  [103, '1002'],
]);

describe('scope parameter', () => {
  it('parses all, all with a group, and a group; ignores anything else', () => {
    expect(parseScope('all')).toEqual({ all: true });
    expect(parseScope('all:1002')).toEqual({ all: true, group: '1002' });
    expect(parseScope('1002')).toEqual({ all: false, group: '1002' });
    expect(parseScope('enhancements.raid_v520')).toEqual({
      all: false,
      group: 'enhancements.raid_v520',
    });
    expect(parseScope('')).toBeUndefined();
    expect(parseScope(null)).toBeUndefined();
    expect(parseScope('a b')).toBeUndefined();
    expect(parseScope('<x>')).toBeUndefined();
  });

  it('writes g only when the item cannot imply it', () => {
    // A group scope is implied by the item's first owner; All always says so.
    expect(scopeValue({ hash: 100, group: '1001' }, false, firstGroup)).toBeUndefined();
    expect(scopeValue({ hash: 100, group: '1001' }, true, firstGroup)).toBe('all');
    // A shared perk opened under its non-first owner needs the group, in either scope.
    expect(scopeValue({ hash: 101, group: '1002' }, false, firstGroup)).toBe('1002');
    expect(scopeValue({ hash: 101, group: '1002' }, true, firstGroup)).toBe('all:1002');
  });

  it('resolves the place from g, else from the item, and never trusts a group without the item', () => {
    const has = (hash: number, group: string) => firstGroup.get(hash) === group || hash === 101;
    expect(resolvePlace(undefined, 103, firstGroup, has)).toEqual({ all: false, group: '1002' });
    expect(resolvePlace({ all: true }, 103, firstGroup, has)).toEqual({ all: true, group: '1002' });
    expect(resolvePlace({ all: false, group: '1002' }, 101, firstGroup, has)).toEqual({
      all: false,
      group: '1002',
    });
    expect(resolvePlace({ all: true, group: '1002' }, 101, firstGroup, has)).toEqual({
      all: true,
      group: '1002',
    });
    // 100 is not listed under 1002: fall back to its own group.
    expect(resolvePlace({ all: false, group: '1002' }, 100, firstGroup, has)).toEqual({
      all: false,
      group: '1001',
    });
  });

  it('keeps ?lang= and ?g= in a route, and drops a malformed or explicitly cleared g', () => {
    expect(tooltipPath(5, '?lang=fr&g=all&line=2')).toBe('/t/5?lang=fr&g=all');
    expect(tooltipPath(5, '?g=1002')).toBe('/t/5?g=1002');
    expect(tooltipPath(5, '?g=a%20b')).toBe('/t/5');
    expect(tooltipPath(5, '?lang=fr&g=all', null)).toBe('/t/5?lang=fr');
    expect(tooltipPath(5, '?lang=fr', 'all:1002')).toBe('/t/5?lang=fr&g=all:1002');
  });
});

describe('wheel gestures', () => {
  const options = { swap: false, grouped: true };
  it('steps entries on Shift and groups on Alt+Shift by default', () => {
    expect(wheelStep(wheel(), options)).toEqual({ kind: 'entry', direction: 1 });
    expect(wheelStep(wheel({ altKey: true, deltaY: -100 }), options)).toEqual({
      kind: 'group',
      direction: -1,
    });
  });

  it('swaps them with the device setting', () => {
    const swapped = { swap: true, grouped: true };
    expect(wheelStep(wheel(), swapped)).toEqual({ kind: 'group', direction: 1 });
    expect(wheelStep(wheel({ altKey: true }), swapped)).toEqual({ kind: 'entry', direction: 1 });
  });

  it('steps entries either way in a category without groups, and ignores a wheel without Shift', () => {
    for (const swap of [false, true])
      for (const altKey of [false, true])
        expect(wheelStep(wheel({ altKey }), { swap, grouped: false })?.kind).toBe('entry');
    expect(wheelStep(wheel({ shiftKey: false }), options)).toBeUndefined();
    expect(wheelStep(wheel({ ctrlKey: true }), options)).toBeUndefined();
  });
});

describe('stepping within a scope', () => {
  const list: Entry[] = [
    { hash: 100, group: '1001' },
    { hash: 101, group: '1001' },
    { hash: 103, group: '1002' },
    { hash: 101, group: '1002' },
  ];
  const index = new Map(list.map((entry, i) => [`${entry.hash}:${entry.group}`, i]));
  const link = (entry: Entry) => `/t/${entry.hash}?g=${entry.group}`;
  const at = (current: Entry, direction: number) =>
    stepTarget(
      { pathname: `/t/${current.hash}`, search: '' },
      direction,
      list,
      index,
      current,
      link,
    );

  it('crosses from one weapon to the next and tells the second listing of a hash apart', () => {
    expect(at({ hash: 101, group: '1001' }, 1)?.entry).toEqual({ hash: 103, group: '1002' });
    expect(at({ hash: 103, group: '1002' }, 1)?.entry).toEqual({ hash: 101, group: '1002' });
    expect(at({ hash: 101, group: '1002' }, -1)?.entry).toEqual({ hash: 103, group: '1002' });
  });

  it('stops at both ends of the scope', () => {
    expect(at({ hash: 100, group: '1001' }, -1)).toBeUndefined();
    expect(at({ hash: 101, group: '1002' }, 1)).toBeUndefined();
    // Not listed under that group: nothing to step from.
    expect(at({ hash: 100, group: '1002' }, 1)).toBeUndefined();
  });
});
