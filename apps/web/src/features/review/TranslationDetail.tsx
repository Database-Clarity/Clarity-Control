import { resolveAlias } from '@clarity/core';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { languageLabel } from '../../languageLabels';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { When } from '../../ui/When';
import { itemFor, listName } from '../navigation/catalog';
import type { Classification } from './kinds';
import { laneComparison, type LaneEntry } from './lanes';
import type { Published } from './published';
import { PlainText, RawMarkup, Sentence, TextChange } from './ReviewDetail';
import styles from './Review.module.scss';

const count = new Intl.NumberFormat('en');

/** What this row changes for players of its language; undefined uses the list's ordinary sentence. */
export function laneSentence(
  entry: LaneEntry,
  { kind }: Classification,
  data: EditorData | null,
  published: Published | undefined,
) {
  const language = languageLabel(entry.lane.lang);
  const live = published?.status === 'ready' ? published.tooltip : null;
  const change = data && live ? laneComparison(data, entry, live) : undefined;
  const back = change?.before.language === 'en' && change.after.language !== 'en';
  switch (kind) {
    case 'New':
      return (
        <>
          <b>New {language} translation.</b> Players see English now.
        </>
      );
    case 'Removed':
      return (
        <>
          <b>Removes the {language} translation.</b> Players see English again.
        </>
      );
    case 'Still correct':
      return (
        <>
          <b>No change to your text.</b> Marks the {language} translation as still correct
          {back ? ': players see it again instead of English.' : '.'}
        </>
      );
    default:
      return undefined;
  }
}

/** The other tooltips whose published text changes with the row, by name; an alias is its original. */
export function AffectedTooltips({
  entry: { lane },
  open,
  className,
}: {
  entry: LaneEntry;
  /** Listed at once, as plain names (the confirmation). */
  open?: boolean;
  className?: string;
}) {
  const data = useDataStore((state) => state.data);
  const hashes = lane.row?.status === 'ready' ? lane.row.affectedHashes : undefined;
  const tooltips = useMemo(
    () =>
      [...new Set((hashes ?? []).map((hash) => (data ? resolveAlias(hash, data.aliases) : hash)))]
        .filter((hash) => hash !== lane.hash)
        .map((hash) => {
          const item = data ? itemFor(hash, data) : undefined;
          return {
            hash,
            name:
              (item && data && listName(item, data)) ||
              data?.bundle.tooltips[hash]?.custom?.name ||
              `Tooltip ${hash}`,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash),
    [data, hashes, lane.hash],
  );
  if (!hashes) return null;
  if (!tooltips.length)
    return lane.id === undefined || open ? null : (
      <p className={styles.note}>Updates no published tooltip.</p>
    );
  const repeated = (index: number) =>
    [tooltips[index - 1], tooltips[index + 1]].some(
      (other) => other?.name === tooltips[index]!.name,
    );
  return (
    <details className={[styles.updates, className].filter(Boolean).join(' ')} open={open}>
      <summary>
        {lane.id === undefined ? 'Also updates' : 'Updates'} {count.format(tooltips.length)}{' '}
        {tooltips.length === 1 ? 'tooltip' : 'tooltips'}
      </summary>
      <ul>
        {tooltips.map(({ hash, name }, index) => (
          <li key={hash}>
            {open ? name : <Link to={`/t/${hash}?lang=${lane.lang}`}>{name}</Link>}
            {repeated(index) && <span className={styles.muted}> · {hash}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A translator's open row: what their language's players see now, and after it. */
export function LaneDetail({
  entry,
  published,
  classification,
  raw,
  onRetry,
}: {
  entry: LaneEntry;
  published: Published | undefined;
  classification: Classification | undefined;
  raw: boolean;
  onRetry(): void;
}) {
  const data = useDataStore((state) => state.data);
  const signedIn = useAuthStore((state) => !!state.user?.role);
  const { lane } = entry;
  const { lang, saved, row } = lane;
  const hash = lane.hash ?? -1;
  const live = published?.status === 'ready' ? published.tooltip : undefined;
  const change = useMemo(
    () => (data && live ? laneComparison(data, entry, live) : undefined),
    [data, entry, live],
  );
  const ready = row?.status === 'ready' && !entry.unpublishable ? row : undefined;
  const removed = !saved;
  const changed =
    change &&
    (change.before.text !== change.after.text || change.before.language !== change.after.language);
  // With no other tooltip in the row's effects, the publisher's fallback is its own.
  const ownFallback = !!ready?.englishFallback && !ready.affectedHashes.length;
  const plain = change?.after;
  return (
    <section aria-label="Selected change" className={styles.detail}>
      <Sentence
        entry={entry}
        published={published}
        classification={classification}
        onRetry={onRetry}
      />
      {!removed && (change?.after.language === 'en' || ownFallback) ? (
        <p className={styles.sentence} data-tone="warn">
          <b>Goes live in English.</b> This {languageLabel(lang)} text is too far behind the
          published English, or uses a number that English removed.
        </p>
      ) : (
        ready?.englishFallback &&
        !removed && (
          <p className={styles.sentence} data-tone="warn">
            <b>Some of these tooltips stay in English.</b> They use something that has no current{' '}
            {languageLabel(lang)} text.
          </p>
        )
      )}
      <AffectedTooltips entry={entry} />
      {signedIn && saved && (
        <p className={styles.savedBy}>
          Saved by {saved.updatedBy} · <When value={saved.updatedAt} />
        </p>
      )}
      <div className={styles.evidence} data-global={signedIn && saved ? undefined : ''}>
        <section lang={lang} aria-label={`${languageLabel(lang)} comparison`}>
          <h4>{languageLabel(lang)}</h4>
          {changed ? (
            <TextChange
              before={change.before.text}
              after={change.after.text}
              previousLanguage={change.before.language}
              currentLanguage={change.after.language}
              lang={lang}
              hash={hash}
              classification={classification}
              side="live"
            />
          ) : plain ? (
            plain.text && (
              <PlainText text={plain.text} lang={plain.language} hash={hash} side="live" />
            )
          ) : (
            // Judged by its saved text while a blocked row has no comparison.
            (entry.unpublishable || published?.status !== 'loading') &&
            entry.tooltip.text[lang] && (
              <PlainText text={entry.tooltip.text[lang].text} lang={lang} hash={hash} side="live" />
            )
          )}
        </section>
      </div>
      {raw &&
        change &&
        (change.source.before === change.source.after ? (
          <p className={styles.note}>Markup unchanged.</p>
        ) : (
          <div className={styles.rawBlock} aria-label="Raw markup">
            <RawMarkup before={change.source.before ?? ''} after={change.source.after ?? ''} />
          </div>
        ))}
    </section>
  );
}
