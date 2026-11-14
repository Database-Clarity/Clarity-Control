/**
 * One Upcoming row opened (scheduled changes, read-only for now): the batch English with the
 * change from current English, and the language's translation as the batch holds it, beside the
 * row's state. Editing translations in a batch (the batch destination) arrives with a later task;
 * until then nothing here writes, and the editor is not involved.
 */
import { Link } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import type { BatchMember } from '@clarity/core/schedule';
import { languageLabel } from '../../languageLabels';
import { zonedNotBefore } from '../../services/format/date';
import { When } from '../../ui/When';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import type { OpenBatch } from '../tooltip/UpcomingSwitch.store';
import { upcomingStateText, upcomingStateTitle, type UpcomingRow } from './upcoming';
import { UpcomingEnglish, UpcomingPane } from './upcomingEnglish';
import styles from './upcoming.module.scss';

const statusLabel: Record<OpenBatch['status'], string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
};

/** Where Previous and Next go, with the position among the rows shown ("2 of 5"). */
export interface DetailSteps {
  previous?: string;
  next?: string;
  position?: string;
}

export function UpcomingDetail({
  row,
  batch,
  member,
  future,
  current,
  steps,
  onBack,
}: {
  row: UpcomingRow;
  batch: OpenBatch;
  member: BatchMember;
  future: Tooltip;
  current: Tooltip | undefined;
  steps: DetailSteps;
  onBack(): void;
}) {
  const language = languageLabel(row.language);
  const translation = future.text[row.language];
  const currentTranslation = current?.text[row.language];
  const english = future.text.en;
  const when = batch.notBefore ? zonedNotBefore(batch.notBefore) : 'No time set';
  const line = [batch.name, statusLabel[batch.status], when, row.category, String(row.hash)];
  return (
    <section className={styles.detail} aria-label={`Upcoming ${language} translation`}>
      <div className={styles.detailBar}>
        <button type="button" className={styles.back} onClick={onBack}>
          <span aria-hidden="true">‹</span> Upcoming
        </button>
        <h1 className={styles.detailName} title={`${row.name} · ${row.hash}`}>
          {row.name}
        </h1>
        <span className={styles.detailState} data-state={row.state} title={upcomingStateTitle(row)}>
          {upcomingStateText[row.state]}
        </span>
        <nav className={styles.steps} aria-label="Upcoming rows">
          <StepLink to={steps.previous} label="Previous" />
          {steps.position && <span className={styles.position}>{steps.position}</span>}
          <StepLink to={steps.next} label="Next" />
        </nav>
      </div>
      <p className={styles.detailLine} title={line.join(' · ')}>
        <span className={styles.segments}>
          {line.map((segment, index) => (
            <span key={index}>{segment}</span>
          ))}
        </span>
      </p>
      <p className={styles.readOnly} role="note">
        Read-only. Editing translations in a batch arrives in a later update.
      </p>
      <div className={styles.panes}>
        <UpcomingPane title={`Upcoming ${language}`}>
          {row.state === 'needs' ? (
            <>
              <p className={styles.note}>
                The batch has no {language} for its English yet.
                {currentTranslation
                  ? ` Current ${language}, written against the current English:`
                  : ` There is no ${language} translation at all.`}
              </p>
              {currentTranslation && (
                <ReadingTooltip
                  text={currentTranslation.text}
                  lang={row.language}
                  hash={row.hash}
                />
              )}
            </>
          ) : (
            <>
              {row.state === 'stale' && english && translation?.sourceUpdatedAt && (
                <p className={styles.note} data-flag="">
                  The batch English changed after this translation (translated against English of{' '}
                  <When value={translation.sourceUpdatedAt} />; the batch English is from{' '}
                  <When value={english.updatedAt} />
                  ).
                </p>
              )}
              {row.currentChanged && (
                <p className={styles.note} data-flag="">
                  Current {language} was {currentTranslation ? 'edited' : 'removed'} after this
                  rework. When the batch publishes, the upcoming {language} below
                  {currentTranslation ? ' replaces it' : ' is restored'}.
                </p>
              )}
              {translation && (
                <ReadingTooltip text={translation.text} lang={row.language} hash={row.hash} />
              )}
              {row.currentChanged && currentTranslation && (
                <div className={styles.changed}>
                  <p className={styles.note}>Current {language} (replaced at publish):</p>
                  <ReadingTooltip
                    text={currentTranslation.text}
                    lang={row.language}
                    hash={row.hash}
                  />
                </div>
              )}
              {!member.base && <p className={styles.note}>New tooltip: the batch creates it.</p>}
            </>
          )}
        </UpcomingPane>
        {english && (
          <UpcomingEnglish
            hash={row.hash}
            current={current?.text.en?.text}
            upcoming={english.text}
          />
        )}
      </div>
    </section>
  );
}

function StepLink({ to, label }: { to: string | undefined; label: string }) {
  return to ? (
    <Link to={to} replace data-perf-navigation="true" className={styles.step}>
      {label}
    </Link>
  ) : (
    <span className={styles.step} aria-disabled="true">
      {label}
    </span>
  );
}
