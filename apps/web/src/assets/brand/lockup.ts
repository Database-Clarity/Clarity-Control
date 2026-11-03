/*
 * The header lockup. Placeholder: lk-r2-j75 (owner picks j75 vs k75 at the end).
 * Swapping the logo is a one-file change: point these two imports at the other pair
 * (lockup-k75-*.svg) or at final artwork. Brand.tsx and CSS do not change.
 * Source artwork is the owner's, exported from the design round (overhaul-r3-fable/shots/lockups-svg).
 * Light is the outlined version, not an inversion of dark.
 */
import dark from './lockup-j75-dark.svg';
import light from './lockup-j75-light.svg';

export const lockup = { dark, light } as const;
