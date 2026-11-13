import { describe, expect, it } from 'vitest';
import { parseMarkup, type MarkupGlobals } from '@clarity/core';
import { presentDiff, renderedDiff, type DiffLine, type DiffSpan } from './renderedDiff';
import {
  accountHunks,
  analyzeSourceOnly,
  sourceParts,
  type HunkAccount,
  type SourceMarker,
} from './sourceOnlyChanges';

const globals: MarkupGlobals = { variables: '', titles: '' };
const options = { budgetMs: 10000, maxParts: 1000 };

/** Marked claim vocabulary per side, rendered line, and word: "side|line|word" → count. */
function markedTokens(diff: ReturnType<typeof renderedDiff>) {
  const available = new Map<string, number>();
  for (const side of ['before', 'after'] as const) {
    const kind = side === 'before' ? 'delete' : 'insert';
    diff[side].forEach((line: DiffLine, index) => {
      const add = (word: string) =>
        available.set(
          `${side}|${index}|${word}`,
          (available.get(`${side}|${index}|${word}`) ?? 0) + 1,
        );
      if (line.diffKind === kind) add('¶');
      for (const span of (line.linesContent ?? []) as DiffSpan[]) {
        if (span.diffKind !== kind) continue;
        if (span.link) add(`‹link›${span.text}›${span.link}`);
        else if (span.title) add(`‹title›${span.text}`);
        else if (span.text) span.text.split(/\s+/).filter(Boolean).forEach(add);
        else for (const name of span.classNames ?? []) add(`<${name}/>`);
      }
    });
  }
  return available;
}

/**
 * Accounts against the real final diff and independently re-verifies every
 * "shown" claim against that diff: each claimed token must be a distinct marked
 * word, icon, link, title, or line structure on the claimed rendered line. Also
 * checks that the displayed form (presentDiff) keeps every one of those marks,
 * and that collapsed markers (one per rendered line) cover each hunk they absorbed.
 */
function account(before: string, after: string, context = globals) {
  const diff = renderedDiff(before, after, context);
  const accounts = accountHunks(before, after, context, diff, options);
  const parts = sourceParts(before, after);
  expect(accounts).toHaveLength(parts.length);
  const available = markedTokens(diff);
  for (const entry of accounts)
    if (entry.account === 'shown')
      for (const [side, line, word] of entry.tokens) {
        const key = `${side}|${line}|${word}`;
        expect(available.get(key) ?? 0, `claimed ${key}`).toBeGreaterThan(0);
        available.set(key, available.get(key)! - 1);
      }
  // The display form only adds marks: no claimed (or any) mark disappears.
  const shown = markedTokens(presentDiff(renderedDiff(before, after, context)));
  for (const [key, total] of markedTokens(diff))
    expect(shown.get(key) ?? 0, `display keeps ${key}`).toBeGreaterThanOrEqual(total);
  const line = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
  const byLine = new Map<number, SourceMarker>();
  const covers = new Map<SourceMarker, number>();
  accounts.forEach((entry, index) => {
    if (entry.account !== 'marker') return;
    const { marker } = entry,
      part = parts[index];
    expect(byLine.get(marker.position) ?? marker, 'one marker per rendered line').toBe(marker);
    byLine.set(marker.position, marker);
    covers.set(marker, (covers.get(marker) ?? 0) + 1);
    for (const [text, range, from, to] of [
      [before, marker.previous, part.from, part.to],
      [after, marker.current, part.nextFrom, part.nextTo],
    ] as const) {
      if (!text) continue;
      expect(range![0]).toBeLessThanOrEqual(line(text, from) + 1);
      expect(range![1]).toBeGreaterThanOrEqual(line(text, Math.max(from, to - 1)));
    }
    const kinds = marker.label.split(' · ')[1].split(', ');
    expect(new Set(kinds).size, marker.label).toBe(kinds.length);
  });
  for (const [marker, total] of covers) expect(marker.hunks).toBe(total);
  return { accounts, diff };
}
/** Marked occurrences of one claim vocabulary word on one side of a final diff. */
function marks(diff: ReturnType<typeof renderedDiff>, side: 'before' | 'after', word: string) {
  const kind = side === 'before' ? 'delete' : 'insert';
  let total = 0;
  for (const line of diff[side] as DiffLine[]) {
    if (word === '¶' && line.diffKind === kind) total++;
    for (const span of (line.linesContent ?? []) as DiffSpan[]) {
      if (span.diffKind !== kind) continue;
      const vocabulary = span.link
        ? [`‹link›${span.text}›${span.link}`]
        : span.title
          ? [`‹title›${span.text}`]
          : span.text
            ? span.text.split(/\s+/).filter(Boolean)
            : (span.classNames ?? []).map((name) => `<${name}/>`);
      total += vocabulary.filter((entry) => entry === word).length;
    }
  }
  return total;
}
const count = (accounts: HunkAccount[], kind: HunkAccount['account']) =>
  accounts.filter((entry) => entry.account === kind).length;
const labels = (accounts: HunkAccount[]) =>
  accounts.flatMap((entry) => (entry.account === 'marker' ? [entry.marker.label] : []));
const both = (before: string, after: string) => [
  [before, after],
  [after, before],
];

describe('named repros, forward and reverse', () => {
  it.each(both('var n = A B\n#n', 'var n = A\n#n B'))(
    'cancelled edits that render identically are flagged: %j → %j',
    (before, after) => {
      const { accounts, diff } = account(before, after);
      expect(JSON.stringify(diff.before)).not.toContain('diffKind');
      expect(JSON.stringify(diff.after)).not.toContain('diffKind');
      expect(accounts.length).toBeGreaterThanOrEqual(2);
      expect(count(accounts, 'marker')).toBe(accounts.length);
      expect(labels(accounts).some((label) => label.includes('Variable n changed'))).toBe(true);
    },
  );
  it.each(both('var n = A B\n#n\nVisible Old', 'var n = A\n#n B\nVisible New'))(
    'a visible edit elsewhere does not hide the cancelled ones: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      const shown = accounts.filter((entry) => entry.account === 'shown');
      expect(shown).toHaveLength(1);
      expect(JSON.stringify(shown)).toMatch(/Old|New/);
      expect(count(accounts, 'marker')).toBe(accounts.length - 1);
    },
  );
  it.each(both('var n = A B\n#n\nX', 'var n = A\n#n B\nB'))(
    'a cancelled word cannot claim the same word marked on another line: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      const cancelled = sourceParts(before, after).findIndex(
        (part) =>
          part.kind === 'source' &&
          `${before.slice(part.from, part.to)}${after.slice(part.nextFrom, part.nextTo)}`.trim() ===
            'B' &&
          before.slice(part.from, part.to) !== 'X' &&
          after.slice(part.nextFrom, part.nextTo) !== 'X',
      );
      expect(cancelled).toBeGreaterThanOrEqual(0);
      expect(accounts[cancelled].account).toBe('marker');
    },
  );
  it.each(both('var n = A B\nvar m = X\n#n and #m', 'var n = A\nvar m = B\n#n B and #m'))(
    'a cancelled word cannot claim another reference’s word on its line: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      expect(count(accounts, 'shown')).toBe(0);
      expect(count(accounts, 'marker')).toBe(accounts.length);
    },
  );
  it.each(both('var n = Old\n<unknown Old 🡅 #n', 'var n = New\n<unknown New 🡅 #n'))(
    'text a stray tag drops is flagged, not proven by a visible word: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      expect(count(accounts, 'shown')).toBe(0);
      expect(count(accounts, 'marker')).toBe(accounts.length);
    },
  );
  it.each(both('', '<pve/>'))(
    'a one-sided structure-only line is shown by a visible bar: %j → %j',
    (before, after) => {
      const { accounts, diff } = account(before, after);
      expect(count(accounts, 'unchecked')).toBe(0);
      expect([...diff.before, ...diff.after].some((line: DiffLine) => line.diffKind)).toBe(true);
    },
  );
  it.each(both('A\nB', 'A\n\nB'))(
    'a production spacer line is a marked line in the final diff: %j → %j',
    (before, after) => {
      const { accounts, diff } = account(before, after);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].account).toBe('shown');
      const marked = [...diff.before, ...diff.after].filter((line: DiffLine) => line.diffKind);
      expect(marked).toHaveLength(1);
      expect(marked[0].classNames).toContain('spacer');
    },
  );
  it.each([
    ...both('A B', 'A\nB').map((pair) => [...pair, 'shown']),
    // Collapsed blank lines and trimmed spaces render the same, so they are flagged.
    ...both('A\n\nB', 'A\n\n\nB').map((pair) => [...pair, 'marker']),
    ...both('A', 'A ').map((pair) => [...pair, 'marker']),
  ])(
    'line breaks and spacing are shown or flagged, never dropped: %j → %j',
    (before, after, kind) => {
      const { accounts } = account(before, after);
      expect(accounts.length).toBeGreaterThan(0);
      expect(count(accounts, kind as HunkAccount['account'])).toBe(accounts.length);
    },
  );
  it.each([
    ...both('var n = 1\n#n damage', 'var n = 2\nNew damage'),
    ...both(
      'title Detail (\nOld detail\n)\n<title Info [Detail] />',
      'title Detail (\nNew detail\n)\nNew visible',
    ),
  ])('newly unused definitions keep their production label: %j → %j', (before, after) => {
    const { accounts } = account(before, after);
    expect(count(accounts, 'unchecked')).toBe(0);
    expect(
      labels(accounts).some((label) => /Variable n changed|Title Detail changed/.test(label)),
    ).toBe(true);
  });
  it.each(both('var n = 1\n#n damage', 'var n = 2\n#n damage'))(
    'a still-referenced variable change is visible in the diff: %j → %j',
    (before, after) => {
      const { accounts, diff } = account(before, after);
      expect(count(accounts, 'unchecked')).toBe(0);
      const marked = (lines: DiffLine[]) =>
        lines
          .flatMap((line) => (line.linesContent ?? []) as DiffSpan[])
          .filter((span) => span.diffKind);
      expect(marked(diff.before).map((span) => span.text)).toEqual([
        before.includes('= 1') ? '1' : '2',
      ]);
      expect(marked(diff.after)).toHaveLength(1);
    },
  );
  it.each([
    ...both('Hits <arc/> targets', 'Hits <void/> targets'),
    ...both('<pve Same text />', '<pvp Same text />'),
    ...both('<pve/>Same line', '<bold/>Same line'),
  ])('icon, tag, and tint changes are marked and accounted: %j → %j', (before, after) => {
    const { accounts, diff } = account(before, after);
    // Each is either proven by its own marked span or line bar, or flagged.
    expect(count(accounts, 'unchecked')).toBe(0);
    expect(JSON.stringify(diff.before)).toContain('"diffKind":"delete"');
    expect(JSON.stringify(diff.after)).toContain('"diffKind":"insert"');
  });
  it.each(
    both(
      '<bold Healing effect is bugged! /> While holding this weapon, a background charge builds at a rate of 5/HPs, healing 5 HP per second. \n\nStowing this weapon immediately dissipates any healing.',
      '<bold Healing effect is bugged! /> \nWhile Chaos Reshaped x2 is active: \nStowing the weapon or keeping it readied grants healing of 5 HP per second.\n\nStowing this weapon grants the effect.',
    ),
  )(
    'owner case (Chaos Reshaped fe0d76c4): word edits beside a trimmed space are shown, not one marker each: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      const markers = new Set(
        accounts.flatMap((entry) => (entry.account === 'marker' ? [entry.marker] : [])),
      );
      // Only the invisible trailing-space edit keeps a marker; every word edit is shown.
      expect(markers.size).toBe(1);
      expect([...markers][0].label).toContain('Line break or spacing');
      expect([...markers][0].hunks).toBe(1);
      expect(count(accounts, 'shown')).toBe(accounts.length - 1);
    },
  );
  it.each(both('Old words here // one', 'New words there // two'))(
    'a hidden edit demotes its line once: one marker lists each kind once: %j → %j',
    (before, after) => {
      const { accounts } = account(before, after);
      const markers = new Set(
        accounts.flatMap((entry) => (entry.account === 'marker' ? [entry.marker] : [])),
      );
      expect(markers.size).toBe(1);
      const [marker] = markers;
      expect(marker.hunks).toBe(accounts.length);
      expect(marker.label).toBe(
        'Source changed · Markup, Comment · previous line 1; current line 1 · see Raw',
      );
    },
  );
  it('plain word edits need no marker', () => {
    for (const [before, after] of [
      ...both('Deals 20 damage', 'Deals 30 damage'),
      ...both('<pve Deals 20 damage />', '<pve Deals 30 damage />'),
      ...both('First\nSecond', 'First\nNew line\nSecond'),
    ]) {
      const { accounts } = account(before, after);
      expect(count(accounts, 'shown')).toBe(accounts.length);
    }
  });
});

it('hidden comment, condition, and declaration edits are flagged with their kind', () => {
  for (const [old, next, kind] of [
    ['enhanced (\nHidden old\n)', 'enhanced (\nHidden new\n)', 'Enhanced'],
    ['var unused = 1', 'var unused = 2', 'Variable unused changed'],
    ['// old comment', '// new comment', 'Comment'],
    ['title Unused (\nOld\n)', 'title Unused (\nNew\n)', 'Title Unused changed'],
    ['export hidden Detail (\nOld\n)', 'export hidden Detail (\nNew\n)', 'Markup'],
  ])
    for (const [before, after] of both(`Old visible\n${old}`, `New visible\n${next}`)) {
      const { accounts } = account(before, after);
      expect(count(accounts, 'shown')).toBe(1);
      expect(labels(accounts).some((label) => label.includes(kind))).toBe(true);
    }
});

it('keeps classified markers and reports exactly the unchecked parts at either cap', () => {
  const before = Array.from({ length: 45 }, (_, i) => `// old ${i}\nSame ${i}`).join('\n');
  const after = before.replaceAll('old', 'new');
  const diff = renderedDiff(before, after, globals);
  const all = analyzeSourceOnly(before, after, globals, diff, options);
  const bounded = analyzeSourceOnly(before, after, globals, diff, { budgetMs: 10000 });
  // Markers on one rendered line collapse; each still counts every hunk it covers.
  const covered = (markers: SourceMarker[]) =>
    markers.reduce((total, marker) => total + marker.hunks, 0);
  expect(all.unchecked).toBe(0);
  expect(covered(all.markers)).toBe(sourceParts(before, after).length);
  expect(all.markers.length).toBeLessThan(covered(all.markers));
  expect(covered(bounded.markers)).toBe(40);
  expect(bounded.unchecked).toBe(covered(all.markers) - 40);
  let time = 0;
  const timed = analyzeSourceOnly(before, after, globals, diff, {
    now: () => (time += 30),
    budgetMs: 50,
  });
  expect(covered(timed.markers)).toBeLessThan(covered(all.markers));
  expect(covered(timed.markers) + timed.unchecked).toBe(covered(all.markers));
});

it('leaves the production render data byte-identical', () => {
  const text = 'Visible\nvar n = 2\nenhanced (\nHidden\n)';
  const saved = JSON.stringify(parseMarkup(text, globals));
  analyzeSourceOnly('Old', text, globals, renderedDiff('Old', text, globals), options);
  expect(JSON.stringify(parseMarkup(text, globals))).toBe(saved);
});

// Seeded random before/after pairs over text, variables, titles, comments, tags,
// and blank lines. Every raw hunk must be shown (re-verified against the final
// diff), flagged, or unchecked; a shown hunk must also change the rendering by
// itself, on a rendered line it claimed.
it('accounts for every hunk of seeded random edits, forward and reverse', () => {
  let seed = 0x5eed1104;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const word = () => pick(['A', 'B', 'X', 'damage', 'Old', 'New', '20', '30', 'hits']);
  const text = () => Array.from({ length: 1 + Math.floor(random() * 3) }, word).join(' ');
  const line = () =>
    pick([
      text,
      text,
      () => '',
      () => `var ${pick(['n', 'm'])} = ${text()}`,
      () => `#${pick(['n', 'm'])} ${text()}`,
      () => `${text()} #${pick(['n', 'm'])}`,
      () => `// ${text()}`,
      () => `${text()} // ${text()}`,
      () => `title ${pick(['T', 'U'])} (\n${text()}\n)`,
      () => `<title ${word()} [${pick(['T', 'U'])}] />`,
      () => `<${pick(['pve', 'pvp', 'bold'])} ${text()} />`,
      () => `${text()} <${pick(['arc', 'void', 'primary'])}/>`,
      () => `${text()} <link ${word()} [https://example.com/${word()}] />`,
      () => `<pve/>${text()}`,
      () => `enhanced (\n${text()}\n)`,
      () => `${text()} {{${text()}}{${text()}}}`,
      () => `${text()} \${1 + ${pick(['2', '3'])}}`,
      () => `< table wide >\n| ${text()} |b ${text()}\n<$>`,
      () => `${text()} <pve/> ${text()}`,
      () => `#e ${text()}`,
      () => `#n ${text()} #m`,
      () => `<unknown ${text()} 🡅 ${text()}`,
      () => `${text()} <pve ${text()}`,
      // Trailing and doubled spaces: inert spacing must never hide a word edit.
      () => `${text()} `,
      () => `${text()}  ${text()}`,
      () => `<bold ${text()} /> ${text()} `,
    ])();
  const mutate = (lines: string[]) => {
    const next = [...lines];
    for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
      const at = Math.floor(random() * (next.length + 1));
      const action = random();
      if (action < 0.3 && next.length) next[Math.min(at, next.length - 1)] = line();
      else if (action < 0.55) next.splice(at, 0, line());
      else if (action < 0.7 && next.length) next.splice(Math.min(at, next.length - 1), 1);
      else if (action < 0.85) next.splice(at, 0, '');
      else if (next.length) {
        const index = Math.min(at, next.length - 1);
        next[index] = next[index].replace(/\b(A|B|X|Old|New|20|30)\b/, () => word());
      }
    }
    return next;
  };
  let shownTotal = 0,
    markerTotal = 0;
  for (let pair = 0; pair < 500; pair++) {
    const first = Array.from({ length: 1 + Math.floor(random() * 5) }, line);
    // Every tenth pair is one-sided (a never-pushed or deleted text).
    const pairText = [first.join('\n'), pair % 10 ? mutate(first).join('\n') : ''];
    for (const [before, after] of both(pairText[0], pairText[1])) {
      if (before === after) continue;
      const { accounts } = account(before, after);
      expect(count(accounts, 'unchecked')).toBe(0);
      const parts = sourceParts(before, after);
      const render = (text: string) => JSON.stringify(parseMarkup(text, globals).lines);
      const rendered = [render(before), render(after)];
      accounts.forEach((entry, index) => {
        if (entry.account !== 'shown') return markerTotal++;
        shownTotal++;
        // A shown hunk has a rendered effect of its own, applied to the old
        // text or reverted from the new one (a removed line's break shows only
        // in the first; claims above are verified against the final diff).
        const part = parts[index];
        const applied =
          before.slice(0, part.from) +
          after.slice(part.nextFrom, part.nextTo) +
          before.slice(part.to);
        const reverted =
          after.slice(0, part.nextFrom) +
          before.slice(part.from, part.to) +
          after.slice(part.nextTo);
        const label = `${JSON.stringify(before)} → ${JSON.stringify(after)} part ${index}`;
        expect(render(applied) !== rendered[0] || render(reverted) !== rendered[1], label).toBe(
          true,
        );
        // Ownership: without this hunk, the final diff loses the marks it
        // claimed (another hunk's identical word on that line cannot stand in
        // for it). A word that also renders on another line is skipped: the
        // diff may re-align it there, and claims are already line-located.
        const final = renderedDiff(before, after, globals);
        const without = {
          before: renderedDiff(applied, after, globals),
          after: renderedDiff(before, reverted, globals),
        };
        const claimed = new Map<string, number>();
        for (const [side, line, word] of entry.tokens) {
          const elsewhere = [final, without[side]].some((diff) =>
            (diff[side] as DiffLine[]).some(
              (other, at) =>
                at !== line &&
                (other.linesContent ?? []).some((span) =>
                  (span.text ?? '').split(/\s+/).includes(word),
                ),
            ),
          );
          if (!elsewhere) claimed.set(`${side}|${word}`, (claimed.get(`${side}|${word}`) ?? 0) + 1);
        }
        for (const [key, needed] of claimed) {
          const [side, word] = key.split('|') as ['before' | 'after', string];
          expect(
            marks(final, side, word) - marks(without[side], side, word),
            `${label} claim ${key}`,
          ).toBeGreaterThanOrEqual(Math.min(needed, 1));
        }
      });
    }
  }
  // The generator must exercise both outcomes, or it proves nothing.
  expect(shownTotal).toBeGreaterThan(50);
  expect(markerTotal).toBeGreaterThan(50);
});
