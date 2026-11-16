import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { Segmented } from '../../ui/RightPane';
import { LoadingSkeleton } from '../../ui/Skeleton';
import { themePreferences } from '../../ui/theme';
import { touchSizes } from '../../stores/settings';
import {
  frameHash,
  frameWidths,
  readSettings,
  scales,
  writeSettings,
  type GallerySettings,
} from './settings';
import styles from './Gallery.module.scss';

/**
 * The UI gallery (maintainers only; it shows no data): a toolbar over a frame that renders every
 * shared element. The frame is the app itself at its own route, so width, theme, interface scale,
 * and touch size behave exactly as on a real device of that size, and none of them touch this
 * window or your saved settings.
 */
export function GalleryPage() {
  const role = useAuthStore((state) => state.user?.role);
  const loading = useAuthStore((state) => state.loading);
  const [params, setParams] = useSearchParams();
  // The controls read this state, which updates at once (a router update is asynchronous, so a
  // checkbox or the search field bound to the URL would flicker back or lose the caret); the URL
  // only mirrors it, so a reload or a shared link keeps the choices.
  const [settings, setSettings] = useState(() => readSettings(params));
  const search = writeSettings(settings).toString();
  useEffect(() => {
    if (params.toString() !== search) setParams(search, { replace: true });
  }, [search, params, setParams]);
  const hash = frameHash(settings);
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const [frameFailed, setFrameFailed] = useState(false);
  const [src, setSrc] = useState(() => frameSrc(hash));
  useEffect(() => {
    if (loading || role !== 'maintainer') return;
    // Browsers can fire load even when framing is blocked, and do not reliably fire error.
    // Wait for the gallery app itself to confirm it mounted instead.
    const timer = window.setTimeout(() => setFrameFailed(true), 15_000);
    const ready = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data !== 'gallery-ready'
      )
        return;
      window.clearTimeout(timer);
      loaded.current = true;
      setFrameFailed(false);
    };
    window.addEventListener('message', ready);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', ready);
    };
  }, [loading, role]);
  useEffect(() => {
    // Once the frame runs, a choice changes its route in place (no reload, no history entry).
    const win = frame.current?.contentWindow;
    if (!loaded.current || !win) return setSrc(frameSrc(hash));
    if (win.location.hash !== hash) win.location.replace(hash);
  }, [hash]);
  if (loading) return <LoadingSkeleton label="Checking maintainer access…" shape="page" />;
  if (role !== 'maintainer')
    return <p role="alert">Maintainer access is required to open the UI gallery.</p>;
  const set = (patch: Partial<GallerySettings>) =>
    setSettings((current) => ({ ...current, ...patch }));
  return (
    <article className={styles.page}>
      <h1>UI gallery</h1>
      <div className={styles.toolbar} role="toolbar" aria-label="Preview settings">
        <span className={styles.tool}>
          Theme
          <Segmented
            label="Theme"
            value={settings.theme}
            options={themePreferences.map((value) => ({ value, label: themeNames[value] }))}
            onChange={(theme) => set({ theme })}
          />
        </span>
        <label className={styles.tool}>
          UI scale
          <select
            className={styles.toolField}
            value={settings.scale}
            onChange={(event) => set({ scale: Number(event.target.value) })}
          >
            {scales.map((scale) => (
              <option key={scale} value={scale}>
                {scale}%
              </option>
            ))}
          </select>
        </label>
        <span className={styles.tool}>
          Touch size
          <Segmented
            label="Touch size"
            value={settings.touch}
            options={touchSizes.map((value) => ({
              value,
              label: value === 'large' ? 'Large' : 'Compact',
            }))}
            onChange={(touch) => set({ touch })}
          />
        </span>
        <span className={styles.tool}>
          Width
          <Segmented
            label="Preview width"
            value={String(settings.width)}
            options={frameWidths.map((width) => ({
              value: String(width),
              label: width ? String(width) : 'Fill',
            }))}
            onChange={(width) => set({ width: Number(width) })}
          />
        </span>
        <label className={styles.tool}>
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(event) => set({ reduceMotion: event.target.checked })}
          />
          Reduced motion
        </label>
        <label className={`${styles.tool} ${styles.search}`}>
          <span className="sr-only">Search elements</span>
          <input
            className={styles.toolField}
            type="search"
            placeholder="Search elements"
            value={settings.query}
            onChange={(event) => set({ query: event.target.value })}
          />
        </label>
      </div>
      <div className={styles.stage}>
        {frameFailed && (
          <p role="alert">
            Preview could not load. Reload the page or open the gallery on the main site.
          </p>
        )}
        <iframe
          ref={frame}
          className={styles.frame}
          title="UI gallery preview"
          src={src}
          data-width={settings.width || undefined}
          style={settings.width ? { width: settings.width } : undefined}
          hidden={frameFailed}
          onError={() => setFrameFailed(true)}
          onLoad={() => {
            // A choice made while the frame was loading.
            const win = frame.current?.contentWindow;
            try {
              if (win && win.location.hash !== hash) win.location.replace(hash);
            } catch {
              setFrameFailed(true);
            }
          }}
        />
      </div>
    </article>
  );
}

const themeNames = { system: 'System', light: 'Light', dark: 'Dark' } as const;

function frameSrc(hash: string): string {
  const url = new URL(window.location.href);
  url.hash = hash;
  return url.toString();
}
