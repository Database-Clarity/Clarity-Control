/**
 * The batch English a translation is written against (scheduled changes, spec "Editor UX"
 * Translations bullet), never Current. "Shows" picks the change from the current English to the
 * upcoming English (a word diff; a markup-only change renders with the newly tagged spans
 * outlined) or the upcoming English rendered. It shares the device's remembered choice with the
 * editor's English pane ("changes" / "current"), so a translator's preference carries over.
 */
import type { ReactNode } from 'react';
import { isMarkupOnly } from '@clarity/core';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { useSettingsStore } from '../../stores/settings';
import { WordDiff } from '../../ui/diff';
import { MarkupOnlyEnglish } from './MarkupOnlyEnglish';
import styles from './upcoming.module.scss';

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

export function UpcomingEnglish({
  hash,
  current,
  upcoming,
}: {
  hash: number;
  /** The current saved English (undefined for a tooltip the batch creates). */
  current: string | undefined;
  /** The batch English. */
  upcoming: string;
}) {
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const remember = useSettingsStore((state) => state.remember);
  const showChanges = (remembered ?? fallback) === 'changes';
  return (
    <UpcomingPane
      title="Upcoming English"
      controls={
        <label className={styles.shows}>
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
    </UpcomingPane>
  );
}
