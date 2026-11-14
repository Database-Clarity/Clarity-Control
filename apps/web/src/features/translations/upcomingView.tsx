/**
 * The Translations tab's Upcoming view (scheduled changes; loaded only by a switch-ON build, for
 * maintainers, editors, and translators). Rows, states, and coverage come from `upcoming.ts` over
 * the editor's Upcoming loader: GET /batches when the view opens (then every minute while visible),
 * and every open batch's members at the listed head (cached per head; re-read only when a batch's
 * revision moves). A row opens the read-only batch view in this tab (`?open=<batchId>:<hash>`,
 * pushed, so Back returns to the list at the same row); editing in a batch arrives later.
 */
import { useCallback, useEffect, useMemo, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { useDataStore } from '../../stores/data';
import {
  ensureBatch,
  ensureOpenBatches,
  refreshBatches,
  startUpcoming,
} from '../tooltip/UpcomingSwitch.load';
import { upcomingStore, type OpenBatch, type UpcomingStore } from '../tooltip/UpcomingSwitch.store';
import { QueueList, rememberOpenedFirst, type RowState } from './QueueList';
import { TranslationsFrame, type UpcomingPageProps } from './TranslationsPage';
import {
  countUpcoming,
  filterUpcoming,
  parseUpcomingFilter,
  upcomingCategories,
  upcomingCoverage,
  upcomingRows,
  upcomingStateText,
  upcomingStateTitle,
  type LoadedBatch,
  type UpcomingFilter,
  type UpcomingFilters,
  type UpcomingRow,
} from './upcoming';
import { UpcomingDetail } from './upcomingDetail';
import styles from './TranslationsPage.module.scss';

const noRows: readonly UpcomingRow[] = [];

/** Open batches whose members have loaded, with those still loading or failed. */
function loadedBatches(memberOf: UpcomingStore['memberOf'], loads: UpcomingStore['loads']) {
  const loaded: LoadedBatch[] = [];
  const pending: OpenBatch[] = [];
  const failed: OpenBatch[] = [];
  for (const batch of new Set(Object.values(memberOf))) {
    const load = loads[batch.id];
    if (load?.state === 'ready') loaded.push({ batch, upcoming: load.upcoming });
    else if (load?.state === 'failed') failed.push(batch);
    else pending.push(batch);
  }
  return { loaded, pending, failed };
}

const openKey = (row: Pick<UpcomingRow, 'batchId' | 'hash'>) => `${row.batchId}:${row.hash}`;

function rowState(row: UpcomingRow): RowState {
  return { text: upcomingStateText[row.state], state: row.state, title: upcomingStateTitle(row) };
}

function UpcomingCoverage({
  rowsFor,
  loading,
  languages,
  language,
  scope,
  open,
  onPick,
}: {
  rowsFor(language: Lang): readonly UpcomingRow[];
  /** Batches are still loading (or the listing failed): counts show a dash, never a false 0. */
  loading: boolean;
  languages: readonly Lang[];
  language: Lang;
  scope: { id: string; label: string } | undefined;
  open: boolean;
  onPick(language: Lang): void;
}) {
  const scopeText = scope ? `${scope.label} only` : 'all categories';
  return (
    <div
      id="translation-coverage"
      className={styles.coverage}
      data-upcoming=""
      data-open={open ? '' : undefined}
      role="group"
      aria-label={`Upcoming coverage by language, ${scopeText}`}
    >
      <div className={styles.coverageTop} aria-hidden="true">
        <div className={styles.coverageScope} title={`Upcoming, ${scopeText}`}>
          Upcoming, {scopeText}
        </div>
        <div className={styles.coverageHead}>
          <span>Language</span>
          <span>Ready</span>
          <span title="Current changed">Changed</span>
          <span>Stale</span>
          <span title="Needs translation">Needs</span>
        </div>
      </div>
      {languages.map((lang) => {
        if (loading)
          return (
            <button
              key={lang}
              type="button"
              data-perf-navigation="true"
              aria-pressed={lang === language}
              aria-label={`${languageLabel(lang)}: not loaded yet`}
              onClick={() => onPick(lang)}
            >
              <span>{languageLabel(lang)}</span>
              <span data-zero="">–</span>
              <span data-zero="">–</span>
              <span data-zero="">–</span>
              <span data-zero="">–</span>
            </button>
          );
        const { ready, changed, stale, needs } = upcomingCoverage(rowsFor(lang), scope?.id);
        return (
          <button
            key={lang}
            type="button"
            data-perf-navigation="true"
            aria-pressed={lang === language}
            aria-label={`${languageLabel(lang)}: ${ready} ready, ${changed} current changed, ${stale} stale, ${needs} need translation`}
            onClick={() => onPick(lang)}
          >
            <span>{languageLabel(lang)}</span>
            <span>{ready}</span>
            <span data-zero={changed ? undefined : ''}>{changed}</span>
            <span data-zero={stale ? undefined : ''}>{stale}</span>
            <span data-zero={needs ? undefined : ''}>{needs}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function UpcomingTranslations({
  language,
  available,
  translator,
  unavailable,
  category,
  query,
  text,
  setText,
  deferredText,
  stateParam,
  opened,
  phone,
  update,
  onPick,
  coverageOpen,
  setCoverageOpen,
  languageControl,
  sourceSwitch,
  filterField,
  onClickCapture,
  onKeyDown,
}: UpcomingPageProps) {
  const data = useDataStore((state) => state.data);
  const navigate = useNavigate();
  const { pathname, search, state: routeState } = useLocation();
  const useStore = upcomingStore();
  const head = useStore((state) => state.head);
  const listFailed = useStore((state) => state.listFailed);
  const memberOf = useStore((state) => state.memberOf);
  const loads = useStore((state) => state.loads);
  const state = parseUpcomingFilter(stateParam);

  // List now and every minute while visible; read every open batch's members as listings arrive.
  useEffect(() => startUpcoming(), []);
  useEffect(() => {
    if (head) ensureOpenBatches();
  }, [head, memberOf]);

  const { loaded, pending, failed } = useMemo(
    () => loadedBatches(memberOf, loads),
    [memberOf, loads],
  );
  // Rows per language, built on demand (the coverage rail asks for every language).
  const rowsFor = useMemo(() => {
    const cache = new Map<Lang, UpcomingRow[]>();
    return (lang: Lang) => {
      let rows = cache.get(lang);
      if (!rows) cache.set(lang, (rows = data ? upcomingRows(data, loaded, lang) : []));
      return rows;
    };
  }, [data, loaded]);
  const rows = language ? rowsFor(language) : noRows;
  const several = useMemo(() => new Set(rows.map((row) => row.batchId)).size > 1, [rows]);
  const categories = useMemo(() => upcomingCategories(rows), [rows]);
  const shownFilters = useMemo<UpcomingFilters>(
    () => ({ state, category, query: deferredText }),
    [state, category, deferredText],
  );
  const shown = useMemo(() => filterUpcoming(rows, shownFilters), [rows, shownFilters]);
  const counts = useMemo(
    () =>
      countUpcoming(category ? filterUpcoming(rows, { state: null, category, query: '' }) : rows),
    [rows, category],
  );

  // A row's read-only view: this page with `open`, and the typed filter committed with it so
  // Back returns to the same list.
  const openPath = useCallback(
    (row: UpcomingRow) => {
      const next = new URLSearchParams(search);
      if (text) next.set('q', text);
      else next.delete('q');
      next.set('open', openKey(row));
      return `${pathname}?${next.toString()}`;
    },
    [pathname, search, text],
  );
  const linkTo = useCallback(
    (row: UpcomingRow) => ({ to: openPath(row), state: { upcomingFromList: true } }),
    [openPath],
  );

  const signature = `upcoming|${language}|${state}|${category}|${deferredText}`;
  const filtered = !!(state || category || query);
  const coverage = !translator && available.length > 0;
  const listingReady = head !== null && !pending.length;

  // ---- The read-only batch view of one row. ----
  const openRow = opened ? rows.find((row) => openKey(row) === opened) : undefined;
  if (opened) {
    const back = () => {
      if ((routeState as { upcomingFromList?: boolean } | null)?.upcomingFromList)
        void navigate(-1);
      else update({ open: null });
    };
    const load = openRow ? loads[openRow.batchId] : undefined;
    if (openRow && load?.state === 'ready') {
      const at = shown.indexOf(openRow);
      const step = (offset: number) => {
        const target = at >= 0 ? shown[at + offset] : undefined;
        return target ? openPath(target) : undefined;
      };
      return (
        <UpcomingDetail
          key={openRow.key}
          row={openRow}
          batch={memberOf[openRow.hash]!}
          member={load.upcoming.members[openRow.hash]!}
          future={load.upcoming.overlay[openRow.hash]!.next}
          current={data?.bundle.tooltips[openRow.hash]}
          steps={{
            previous: step(-1),
            next: step(1),
            position: at >= 0 ? `${at + 1} of ${shown.length}` : undefined,
            state: routeState,
          }}
          onBack={back}
        />
      );
    }
    // Why the row is not shown: still loading, a load failed (with its Retry), or truly gone.
    const openedBatch = opened.split(':')[0];
    const failedBatch = failed.find((batch) => batch.id === openedBatch);
    const listingFailed = listFailed && head === null;
    const waiting =
      !listingFailed &&
      !failedBatch &&
      (head === null || pending.some((b) => b.id === openedBatch));
    const message = listingFailed
      ? 'Scheduled batches did not load.'
      : failedBatch
        ? `"${failedBatch.name}" did not load.`
        : waiting
          ? 'Loading the upcoming translation…'
          : 'This row is no longer upcoming: its batch closed, or current English caught up.';
    return (
      <TranslationsFrame
        rail={false}
        bar={sourceSwitch}
        summary={null}
        coverage={null}
        listing={
          <p className={styles.empty} role={listingFailed || failedBatch ? 'alert' : 'status'}>
            {message}
            {(listingFailed || failedBatch) && (
              <button
                type="button"
                onClick={() => (failedBatch ? ensureBatch(failedBatch.id) : void refreshBatches())}
              >
                Retry
              </button>
            )}
            {!waiting && (
              <button type="button" onClick={back}>
                Back to Upcoming
              </button>
            )}
          </p>
        }
      />
    );
  }

  const openFirst = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const first = filterUpcoming(rows, { state, category, query: text })[0];
    if (!first) return;
    // Back must return to this filter, so it is in the list's URL before the view opens.
    if (text !== query) update({ q: text || null });
    rememberOpenedFirst(`upcoming|${language}|${state}|${category}|${text}`, first.key);
    void navigate(openPath(first), { state: { upcomingFromList: true } });
  };
  const setFilter = (value: Exclude<UpcomingFilter, null>) =>
    update({ state: state === value ? null : value });
  const field = filterField(openFirst);
  const countLine = (
    <span className={styles.count} role="status">
      {!listingReady
        ? listFailed && head === null
          ? 'Not loaded'
          : 'Loading batches…'
        : filtered
          ? `${shown.length} of ${rows.length}`
          : `${rows.length} upcoming`}
    </span>
  );

  return (
    <TranslationsFrame
      upcoming
      rail={coverage}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
      bar={
        <>
          {sourceSwitch}
          {languageControl}
          {language && (
            <>
              <label className={styles.categories}>
                <span className="sr-only">Category</span>
                <select
                  data-perf-navigation="true"
                  value={
                    category && categories.some((option) => option.id === category) ? category : ''
                  }
                  onChange={(event) => update({ cat: event.target.value || null })}
                >
                  <option value="">All categories</option>
                  {categories.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} ({option.count})
                    </option>
                  ))}
                </select>
              </label>
              {!phone && field}
              {phone && countLine}
            </>
          )}
        </>
      }
      summary={
        language && (
          <>
            {phone && field}
            <div role="group" aria-label="Show">
              <button
                type="button"
                data-perf-navigation="true"
                aria-pressed={state === 'todo'}
                title="Needs translation, Stale, and Current changed"
                onClick={() => setFilter('todo')}
              >
                To do{listingReady && ` ${counts.todo}`}
              </button>
              <button
                type="button"
                data-perf-navigation="true"
                aria-pressed={state === 'ready'}
                title="Translated against the batch English"
                onClick={() => setFilter('ready')}
              >
                Ready{listingReady && ` ${counts.ready}`}
              </button>
            </div>
            {coverage && (
              <button
                type="button"
                className={styles.coverageToggle}
                aria-expanded={coverageOpen}
                aria-controls="translation-coverage"
                onClick={() => setCoverageOpen(!coverageOpen)}
              >
                Coverage
              </button>
            )}
            {!phone && countLine}
          </>
        )
      }
      coverage={
        coverage &&
        language && (
          <UpcomingCoverage
            rowsFor={rowsFor}
            loading={!listingReady}
            languages={available}
            language={language}
            scope={category ? categories.find((option) => option.id === category) : undefined}
            open={coverageOpen}
            onPick={onPick}
          />
        )
      }
      listing={
        <>
          {unavailable && (
            <p className={styles.empty} role="status">
              {languageLabel(unavailable)} is not one of your assigned languages. Showing{' '}
              {language ? languageLabel(language) : 'nothing'}.
            </p>
          )}
          {listFailed && head === null && (
            <p className={styles.empty} role="alert">
              Scheduled batches did not load.
              <button type="button" onClick={() => void refreshBatches()}>
                Retry
              </button>
            </p>
          )}
          {failed.length > 0 && (
            <p className={styles.empty} role="alert">
              {failed.length === 1
                ? `"${failed[0]!.name}" did not load.`
                : `${failed.length} batches did not load.`}
              <button
                type="button"
                onClick={() => {
                  for (const batch of failed) ensureBatch(batch.id);
                }}
              >
                Retry
              </button>
            </p>
          )}
          {!language ? (
            <p className={styles.empty}>
              {translator
                ? 'You have no assigned languages, so there is nothing to translate.'
                : 'No languages to translate.'}
            </p>
          ) : shown.length ? (
            <QueueList<UpcomingRow>
              key={signature}
              signature={signature}
              rows={shown}
              linkTo={linkTo}
              secondary={(row) => (several ? `${row.batchName} · ${row.category}` : row.category)}
              rowState={rowState}
              title={(row) => `${row.name} · ${row.hash} · ${row.batchName}`}
              label={`${languageLabel(language)} upcoming translations`}
            />
          ) : !listingReady ? (
            !listFailed && (
              <p className={styles.empty} role="status">
                Loading scheduled batches…
              </p>
            )
          ) : failed.length && !filtered && !loaded.length ? null : (
            // Beside a load error, never claim there is nothing to do: speak only for what loaded.
            <p className={styles.empty} role="status">
              {filtered
                ? 'No upcoming translations match these filters.'
                : failed.length
                  ? 'Nothing to translate in the batches that loaded.'
                  : 'No open batch changes English that needs translating.'}
              {filtered && (
                <button
                  type="button"
                  onClick={() => {
                    setText('');
                    update({ state: null, cat: null, q: null });
                  }}
                >
                  Clear filters
                </button>
              )}
            </p>
          )}
        </>
      }
    />
  );
}
