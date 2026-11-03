import { describe, expect, it } from 'vitest';
import { parseMarkup, type MarkupGlobals, type MarkupLine } from '@clarity/core';
import { compareRenders } from './compare';

// Kinetic Tremors' stored text (the base perk); the enhanced version is derived from it.
const KINETIC_TREMORS = `Scoring multiple Direct Hits against a target within 3 seconds of each emits 3 damaging shockwaves from its location at the time of activation. Hit counter persists through stow.

Each shockwave deals up to <pve 90 /> <pvp [20] /> damage in a 6 meter radius. Shockwaves deal 33.33% more damage when activated on <link Miniboss or higher tier [#CombatantClassifications] /> PvE Combatants.

Shockwaves inherit Weapon Damage Buffs, the weapon's passive Kinetic Damage Bonus in PVE (10% on <primary/>Primary, 15% on <special/>Special). They also count as non-direct Hits with the weapon for other interactions.

Hits required for Activation:
• Submachine Guns: #e\${14-#d}
• Auto Rifles: #e\${12-#d}
• Pulse Rifles: #e\${11-#d}
• Sidearms: #e\${8-#d}
• Hand Cannons or Scout Rifles (Rapid-Fire and Precision-Frame): #e\${6-#d}
• All other Hand Cannons and Scout Rifles: #e\${5-#d}
• Rocket Sidearms: #e\${4-#d}
• Bows, Sniper Rifles: #e\${3-#d}

var d = 0

enhanced (
var d = 1
#e Hit Requirements are decreased by 1.
)`;

const globals = (type: string): MarkupGlobals => ({
  variables: 'var e = 🡅',
  titles: '',
  type,
});
const render = (text: string, type: string): MarkupLine[] => parseMarkup(text, globals(type)).lines;
const flat = (line: MarkupLine) =>
  (line.linesContent ?? []).map((span) => span.text ?? '').join('');

describe('compareRenders', () => {
  const base = render(KINETIC_TREMORS, 'Weapon Trait');
  const enhanced = render(KINETIC_TREMORS, 'Weapon Trait Enhanced');

  it('finds the nine changes in Kinetic Tremors: eight values and one enhanced-only line', () => {
    const { lines, changes } = compareRenders(base, enhanced);
    expect(changes).toBe(9);
    expect(lines.filter((line) => line.kind === 'changed')).toHaveLength(8);
    const added = lines.filter((line) => line.kind === 'added');
    expect(added).toHaveLength(1);
    expect(flat(added[0].line)).toContain('Hit Requirements are decreased by 1.');
    expect(lines.filter((line) => line.kind === 'removed')).toHaveLength(0);
  });

  it('shows a changed value as the struck base value and the enhanced value', () => {
    const { lines } = compareRenders(base, enhanced);
    const changed = lines.find((line) => flat(line.line).includes('Submachine'))!;
    expect(changed.kind).toBe('changed');
    const change = changed.segments!.find((segment) => segment.kind === 'change');
    expect(change).toMatchObject({ kind: 'change' });
    if (change?.kind !== 'change') throw new Error('no change');
    expect(change.was.map((span) => span.text?.trim())).toEqual(['14']);
    expect(change.now.map((span) => span.text?.trim())).toEqual(['13']);
    // The words around it stay as they are.
    const first = changed.segments![0];
    expect(first.kind).toBe('same');
  });

  it('reports no changes for identical renders and keeps every line', () => {
    const { lines, changes } = compareRenders(base, base);
    expect(changes).toBe(0);
    expect(lines).toHaveLength(base.length);
    expect(lines.every((line) => line.kind === 'same')).toBe(true);
  });

  it('marks a line only the base has as removed, in order', () => {
    const before = render('Alpha\n\nBeta line\n\nGamma', 'Weapon Trait');
    const after = render('Alpha\n\nGamma', 'Weapon Trait');
    const { lines, changes } = compareRenders(before, after);
    expect(lines.filter((line) => line.kind === 'removed').map((line) => flat(line.line))).toEqual([
      'Beta line',
    ]);
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(lines.filter((line) => line.kind !== 'removed')).toHaveLength(after.length);
  });

  it('does not pair unrelated lines', () => {
    const { lines } = compareRenders(render('One apple', 'x'), render('Two oranges', 'x'));
    expect(lines.map((line) => line.kind).sort()).toEqual(['added', 'removed']);
  });
});
