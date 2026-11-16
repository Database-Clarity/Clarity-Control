import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { applyDeviceSettings, useSettingsStore } from '../../stores/settings';
import { LoadingSkeleton } from '../../ui/Skeleton';
import { entries, type GalleryEntry } from './entries';
import { readSettings } from './settings';
import styles from './Gallery.module.scss';

// The OS setting cannot be switched from a page; this stops the frame's animations and transitions
// the way the components' own reduced-motion rules do.
const reducedMotion =
  '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';

const matches = (entry: GalleryEntry, query: string) =>
  [entry.title, entry.group, entry.from, entry.note, ...entry.states.map((state) => state.label)]
    .join('\n')
    .toLowerCase()
    .includes(query);

/**
 * The gallery's content, shown inside the UI gallery's frame (its own document, outside the app
 * shell, so it loads no workspace data). The theme, interface scale, and touch size it is given
 * apply to this document only and are never saved.
 */
export function GalleryFrame() {
  const [params] = useSearchParams();
  const { theme, scale, touch, reduceMotion, query } = readSettings(params);
  const role = useAuthStore((state) => state.user?.role);
  const loading = useAuthStore((state) => state.loading);
  useEffect(() => {
    // Nothing else signs in outside the shell.
    if (!useAuthStore.getState().user) void useAuthStore.getState().load();
  }, []);
  useLayoutEffect(() => {
    const apply = () =>
      applyDeviceSettings({
        ...useSettingsStore.getState().device,
        theme,
        uiScale: scale,
        touchSize: touch,
      });
    apply();
    // The store re-applies the saved settings when they change (another tab); the preview wins.
    return useSettingsStore.subscribe(apply);
  }, [theme, scale, touch]);
  useLayoutEffect(() => {
    if (!reduceMotion) return;
    const style = document.createElement('style');
    style.textContent = reducedMotion;
    document.head.append(style);
    return () => style.remove();
  }, [reduceMotion]);
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = entries.filter((entry) => !needle || matches(entry, needle));
    return [...new Set(shown.map((entry) => entry.group))].map((group) => ({
      group,
      entries: shown.filter((entry) => entry.group === group),
    }));
  }, [needle]);
  if (loading) return <LoadingSkeleton label="Checking maintainer access…" shape="page" />;
  if (role !== 'maintainer')
    return (
      <p role="alert" className={styles.gallery}>
        Maintainer access is required to open the UI gallery.
      </p>
    );
  return (
    <main className={styles.gallery}>
      {groups.length === 0 && (
        <p className={styles.empty}>
          No elements match “{query.trim()}”. Clear the search to see all {entries.length}.
        </p>
      )}
      {groups.map(({ group, entries: list }) => (
        <section key={group} aria-labelledby={`group-${group.replace(/\W+/g, '-')}`}>
          <h2 id={`group-${group.replace(/\W+/g, '-')}`} className={styles.groupTitle}>
            {group}
          </h2>
          {list.map((entry) => (
            <section key={entry.id} className={styles.entry} aria-labelledby={`entry-${entry.id}`}>
              <header className={styles.entryHead}>
                <h3 id={`entry-${entry.id}`}>{entry.title}</h3>
                <code>{entry.from}</code>
              </header>
              <p className={styles.note}>{entry.note}</p>
              <div className={styles.states}>
                {entry.states.map(({ label, View }) => (
                  <div
                    key={label}
                    className={styles.state}
                    data-long={/^Long/.test(label) || undefined}
                  >
                    <span className={styles.stateLabel}>{label}</span>
                    <View />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </section>
      ))}
    </main>
  );
}
