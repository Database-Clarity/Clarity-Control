// Build state from the site manifest and notices: the list's status dot and the project header's
// "Live 12:03 · v1 · 1.8 MB" line.
import { When } from '../../ui/When';
import { buildState, isFailure, type SiteManifest, type SiteNotice } from './site';
import styles from './Exports.module.scss';

export type DotState = 'live' | 'warn' | 'bad' | 'none' | 'unknown';

export function BuildDot({ state }: { state: DotState }) {
  const label = {
    live: 'Built',
    warn: 'Kept from an earlier build',
    bad: 'Failed',
    none: 'Not built',
    unknown: 'Build status unknown',
  }[state];
  return (
    <span className={styles.dot} data-state={state} role="img" aria-label={label} title={label} />
  );
}

export function projectBuild(
  manifest: SiteManifest | null,
  notices: readonly SiteNotice[],
  project: string,
) {
  const files = Object.entries(manifest?.files ?? {}).filter(
    ([path]) => path.startsWith(`${project}/`) && !path.endsWith('/index.json'),
  );
  const own = notices.filter((notice) => notice.project === project);
  const failures = own.filter(isFailure).length;
  const at = files
    .map(([, file]) => file.lastBuilt ?? file.lastUpdate)
    .sort()
    .at(-1);
  const kept = files.some(([, file]) => file.outcome !== 'built');
  const state: DotState = !manifest
    ? 'unknown'
    : failures
      ? 'bad'
      : !files.length
        ? 'none'
        : kept
          ? 'warn'
          : 'live';
  return {
    state,
    at,
    label: manifest ? 'Not built' : '–',
    failures,
    notices: own.length,
  };
}

export const formatBytes = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(2)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

/** One URL's state for the project header. */
export function FileBuildStatus({
  manifest,
  notices,
  path,
  formatVersion,
}: {
  manifest: SiteManifest | null;
  notices: readonly SiteNotice[];
  path: string;
  formatVersion: number;
}) {
  const state = buildState(manifest, path);
  const failed = notices.filter((notice) => notice.path === path && isFailure(notice));
  if (state.kind === 'absent')
    return (
      <span className={styles.buildCell} title={failed.map((notice) => notice.message).join('\n')}>
        <BuildDot state={failed.length ? 'bad' : 'none'} />
        {failed.length ? 'Build failed · not published' : 'Not built yet'}
      </span>
    );
  const word = state.kind === 'live' ? 'Live' : state.kind === 'carried' ? 'Carried' : 'Frozen';
  return (
    <span
      className={styles.buildCell}
      title={failed.map((notice) => notice.message).join('\n') || undefined}
    >
      <BuildDot state={failed.length ? 'bad' : state.kind === 'live' ? 'live' : 'warn'} />
      {word} <When value={state.file.lastUpdate} nowrap />{' '}
      {/* One piece: a narrow header wraps the status before it, never inside it. */}
      <span>
        · v{formatVersion} · {formatBytes(state.file.bytes)}
      </span>
    </span>
  );
}
