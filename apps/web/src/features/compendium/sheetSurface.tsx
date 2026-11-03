import { createContext, useContext, type ReactNode } from 'react';
import type { CompendiumCell } from '@clarity/core';
import { useSettingsStore } from '../../stores/settings';
import styles from './Compendium.module.scss';

export type CompendiumSurface = 'sheet' | 'editor';

/**
 * The editor-surface colours of a Compendium cell, mirrored from `--sheet-bg` in ui/tokens.scss
 * (sheetSurface.test.ts keeps the two in step). Both themes keep a dark cell, because the sheet's
 * own text colours are tuned for dark cells; the light theme's is raised a little so it sits better
 * on the light page.
 */
export const sheetSurfaceColors = { dark: '#1a1b29', light: '#2a2e44' } as const;
/** Text with no colour of its own on the editor surface (`--sheet-text`). */
export const sheetTextColor = '#cccccc';

const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const value = channel(hex, at) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
/**
 * `color` made legible on `background`: unchanged when it already reaches AA (4.5), otherwise
 * mixed toward white (dark background) or black (light background) by the smallest 5 % step that
 * does, so its hue survives.
 */
export function readableOn(color: string, background: string): string {
  if (contrastRatio(color, background) >= 4.5) return color;
  const target = luminance(background) > 0.4 ? 0 : 255;
  for (let mix = 5; mix <= 100; mix += 5) {
    const candidate = `#${[1, 3, 5]
      .map((at) =>
        Math.round(channel(color, at) + ((target - channel(color, at)) * mix) / 100)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return target ? '#ffffff' : '#000000';
}

/** The Compendium cell backgrounds this device shows (the sheet's own until the user switches). */
export function useCompendiumSurface(): [CompendiumSurface, (surface: CompendiumSurface) => void] {
  const surface = useSettingsStore((state) => state.device.remembered.compendiumSurface ?? 'sheet');
  const remember = useSettingsStore((state) => state.remember);
  return [surface, (value) => remember({ compendiumSurface: value })];
}

/** Text colours drawn on the editor surface must be legible there; sheet cells stay faithful. */
const LegibleOn = createContext<string | undefined>(undefined);
export const useLegibleOn = () => useContext(LegibleOn);

/**
 * One Compendium cell's surface: the cell's own sheet background (default), or the editor surface
 * when the user chose that, or when the sheet gave the cell no background. Sheet backgrounds keep
 * the sheet's text colours exactly; on the editor surface a colour that would not be AA there is
 * lightened just enough. Cells with no colour of their own take readable default text either way.
 */
export function SheetCell({
  background,
  children,
}: {
  /** The cell's sheet background (`CompendiumCell.background`). */
  background?: CompendiumCell['background'];
  children: ReactNode;
}) {
  const [surface] = useCompendiumSurface();
  const sheet = surface === 'sheet' && background ? background : undefined;
  const style = sheet ? { background: sheet, color: readableOn(sheetTextColor, sheet) } : undefined;
  return (
    <LegibleOn.Provider value={sheet ? undefined : sheetSurfaceColors.light}>
      <div className={styles.cell} data-surface={sheet ? 'sheet' : 'editor'} style={style}>
        {children}
      </div>
    </LegibleOn.Provider>
  );
}

/** Pane-header switch: the sheet's cell colours, or the editor surface (pressed = sheet colours). */
export function SheetColoursToggle() {
  const [surface, setSurface] = useCompendiumSurface();
  const sheet = surface === 'sheet';
  return (
    <button
      type="button"
      className={styles.surfaceToggle}
      aria-pressed={sheet}
      aria-label="Sheet colours"
      title={
        sheet
          ? "Sheet colours: showing the Compendium's own cell backgrounds. Click for the editor surface."
          : "Editor surface. Click to show the Compendium's own cell backgrounds."
      }
      onClick={() => setSurface(sheet ? 'editor' : 'sheet')}
    >
      {/* A cell swatch: a filled half when the sheet's own colours are showing. */}
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
        <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" />
        <path d="M2 12 12 2v10z" fill="currentColor" opacity={sheet ? 1 : 0.25} />
      </svg>
    </button>
  );
}
