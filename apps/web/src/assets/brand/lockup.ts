/*
 * The header lockup. lk-r2-k75 (owner 2026-11-03: "go with k75 for now but retain j75").
 * Swapping the logo is a one-file change: point these two imports at the other pair
 * (lockup-j75-*.svg is kept) or at final artwork. Brand.tsx and CSS do not change.
 * Source artwork is the owner's, exported from the design round (overhaul-r3-fable/shots/lockups-svg).
 * Light is the outlined version, not an inversion of dark.
 */
import dark from './lockup-k75-dark.svg';
import light from './lockup-k75-light.svg';
import markDark from './mark-dark.svg';
import markLight from './mark-light.svg';

export const lockup = { dark, light } as const;

/** The diamond mark alone (the favicon artwork): bare on dark, on its black backdrop on light. */
export const mark = { dark: markDark, light: markLight } as const;
