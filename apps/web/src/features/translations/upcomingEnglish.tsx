/**
 * The batch English a translation is written against (scheduled changes, spec "Editor UX"
 * Translations bullet), never Current. "Shows" picks the change from the current English to the
 * upcoming English (a word diff; a markup-only change renders with the newly tagged spans
 * outlined) or the upcoming English rendered. It shares the device's remembered choice with the
 * editor's English pane ("changes" / "current"), so a translator's preference carries over.
 */
import { useMemo, type ReactNode } from 'react';
import { isMarkupOnly, type MarkupGlobals } from '@clarity/core';
import { ReadingGlobals, ReadingTooltip } from '../preview/ReadingTooltip';
import { useSettingsStore } from '../../stores/settings';
import { WordDiff } from '../../ui/diff';
import { MarkupOnlyEnglish } from './MarkupOnlyEnglish';
import styles from './upcoming.module.scss';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import editorStyles from '../tooltip/BatchDestination.module.scss';
import { useDataStore } from '../../stores/data';
import { upcomingStore } from '../tooltip/UpcomingSwitch.store';
import { tooltipImports } from '../../services/tooltipImports';

/** A titled pane of the read-only batch view: a one-line header above a body that scrolls. */
export function UpcomingPane({
  title,
  label,
  controls,
  children,
}: {
  title: string;
  label?: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.pane} aria-label={label ?? title}>
      <div className={styles.paneHeader}>
        <h2>{title}</h2>
        {controls}
      </div>
      <div className={styles.paneBody}>{children}</div>
    </section>
  );
}

/** The shared content in the editor's scrollable side pane and tab header. */
function EditorUpcomingPane({
  title,
  controls,
  children,
}: {
  title: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RightPane label={title} header={<RightPaneHeader title={title}>{controls}</RightPaneHeader>}>
      {children}
    </RightPane>
  );
}

export function UpcomingEnglish({
  hash,
  current,
  upcoming,
  globals,
  editor = false,
  notice,
}: {
  hash: number;
  /** The current saved English (undefined for a tooltip the batch creates). */
  current: string | undefined;
  /** The batch English. */
  upcoming: string;
  /** Resolve imports against the complete batch future state. */
  globals?: MarkupGlobals;
  /** Use the editor pane shell, including its English/Compendium/Reports tabs. */
  editor?: boolean;
  notice?: ReactNode;
}) {
  const data = useDataStore((state) => state.data);
  const overlay = upcomingStore()((state) => {
    const batch = state.memberOf[hash];
    const load = batch ? state.loads[batch.id] : undefined;
    return load?.state === 'ready' ? load.upcoming.overlay : undefined;
  });
  const sourceGlobals = useMemo(() => {
    if (globals) return globals;
    // Read-only Upcoming uses the same future imports as the editor, never Current drafts.
    const imports =
      data && overlay ? tooltipImports(data.bundle.tooltips, overlay, 'en', data.aliases) : {};
    return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
  }, [data, overlay, globals]);
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const remember = useSettingsStore((state) => state.remember);
  const showChanges = (remembered ?? fallback) === 'changes';
  const Pane = editor ? EditorUpcomingPane : UpcomingPane;
  return (
    <Pane
      title="Upcoming English"
      controls={
        <label className={editor ? editorStyles.shows : styles.shows}>
          <span>Shows:</span>
          <select
            aria-label="Upcoming English shows"
            value={showChanges ? 'changes' : 'current'}
            onChange={(event) =>
              remember({ englishSource: event.target.value === 'changes' ? 'changes' : 'current' })
            }
          >
            <option value="changes">Changes from current</option>
            <option value="current">Upcoming English</option>
          </select>
        </label>
      }
    >
      <ReadingGlobals.Provider value={sourceGlobals}>
        {notice}
        <div className={editor ? editorStyles.englishContent : undefined}>
          {!showChanges ? (
            <ReadingTooltip text={upcoming} hash={hash} />
          ) : current === undefined ? (
            <>
              <p className={styles.note}>New in this batch: there is no current English.</p>
              <ReadingTooltip text={upcoming} hash={hash} />
            </>
          ) : current === upcoming ? (
            <p className={styles.note}>The batch does not change the English.</p>
          ) : isMarkupOnly(current, upcoming) ? (
            <MarkupOnlyEnglish before={current} current={upcoming} hash={hash} />
          ) : (
            <div aria-label="English changes in the batch">
              <p className={styles.note}>
                Current English → upcoming English. Removed words are struck through; additions are
                underlined.
              </p>
              <WordDiff before={current} after={upcoming} />
            </div>
          )}
        </div>
      </ReadingGlobals.Provider>
    </Pane>
  );
}
