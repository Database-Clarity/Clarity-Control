import { themePreferences, type ThemePreference } from '../../ui/theme';
import {
  touchSizes,
  uiScaleMax,
  uiScaleMin,
  uiScaleStep,
  type TouchSize,
} from '../../stores/settings';

/** The gallery toolbar's choices. They apply to the preview frame only and are never saved. */
export interface GallerySettings {
  theme: ThemePreference;
  scale: number;
  touch: TouchSize;
  reduceMotion: boolean;
  /** Preview frame width in CSS pixels; 0 fills the page. */
  width: number;
  query: string;
}

export const frameWidths = [0, 390, 768, 1280] as const;

export const scales: readonly number[] = Array.from(
  { length: (uiScaleMax - uiScaleMin) / uiScaleStep + 1 },
  (_, index) => uiScaleMin + index * uiScaleStep,
);

const pick = <T>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

export function readSettings(params: URLSearchParams): GallerySettings {
  return {
    theme: pick(params.get('theme'), themePreferences, 'system'),
    scale: pick(Number(params.get('scale')), scales, 100),
    touch: pick(params.get('touch'), touchSizes, 'compact'),
    reduceMotion: params.get('motion') === 'reduce',
    width: pick(Number(params.get('width')), frameWidths, 0),
    query: params.get('q') ?? '',
  };
}

/** Only the choices that differ from the defaults, so the URL stays short. */
export function writeSettings(settings: GallerySettings): URLSearchParams {
  const params = new URLSearchParams();
  if (settings.theme !== 'system') params.set('theme', settings.theme);
  if (settings.scale !== 100) params.set('scale', String(settings.scale));
  if (settings.touch !== 'compact') params.set('touch', settings.touch);
  if (settings.reduceMotion) params.set('motion', 'reduce');
  if (settings.width) params.set('width', String(settings.width));
  if (settings.query) params.set('q', settings.query);
  return params;
}

/** The frame's route: the same choices, read by GalleryFrame inside the iframe. */
export function frameHash(settings: GallerySettings): string {
  const search = writeSettings({ ...settings, width: 0 }).toString();
  return `#/management/ui/frame${search ? `?${search}` : ''}`;
}
