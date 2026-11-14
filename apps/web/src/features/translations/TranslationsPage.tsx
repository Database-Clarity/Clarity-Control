import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { canonicalHash } from '../navigation/catalog';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import {
  SkeletonRegion,
  SkeletonRows,
  SkeletonStatus,
  useSkeletonVisible,
} from '../../ui/Skeleton';
import { QueueList, rememberOpenedFirst } from './QueueList';
import {
  categoryOptions,
  countRows,
  filterRows,
  parseStateFilter,
  queueFor,
  translationIndex,
  type QueueFilters,
  type QueueRow,
  type TranslationIndex,
} from './queue';
import { availableLanguages, entryPath, queuePath, queueSummary } from './worklist';
import { newQueueId, visitState } from '../queue/model';
import type { TranslationsRestore } from '../queue/sources';
import { startQueue } from '../queue/start';
import { translationItem } from '../queue/translationRows';
import { returnedState } from '../queue/WorkThroughBar';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './TranslationsPage.module.scss';
import { useLeftQueue } from '../queue/useQueue';

const searchDelayMs = 200;
const noRows: readonly QueueRow[] = [];

export type TranslationsSource = 'current' | 'upcoming';

// Scheduled changes (spec "Editor UX", Translations bullet): the Upcoming view is its own lazy
// chunk, and the build-switch test sits on the import itself, so a switch-OFF build has neither
// the view nor its switch (I6: nothing renders, nothing is requested or stored).
const UpcomingTranslations = lazy(() =>
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? import('./upcomingView')
    : Promise.reject(new Error('Scheduled changes are off')),
);
/** Roles that may read batches (trials get no batch access, Q3; signed-out visitors none). */
const batchRoles = new Set(['maintainer', 'editor', 'translator']);
/**
 * The tab's Current / Upcoming choice: this page's memory only (per browser tab, never stored or
 * synced, and separate from the editor's preview switch), so a reload starts on Current.
 */
let rememberedSource: TranslationsSource = 'current';

/** Tests: forget the remembered choice. */
export function resetTranslationsSource() {
  rememberedSource = 'current';
}

export function Loading() {
  return (
    <div className={styles.page}>
      <SkeletonStatus>Loading translation queue</SkeletonStatus>
      <SkeletonRegion className={styles.skeleton}>
        <SkeletonRows count={12} maxRows={20} columns={[55, 25, 12]} rowHeight="2rem" />
      </SkeletonRegion>
    </div>
  );
}

/**
 * The tab's layout, shared by the Current queue and the Upcoming view: the heading bar, the
 * summary line, and the body (an optional coverage rail beside the listing).
 */
export function TranslationsFrame({
  rail,
  bar,
  summary,
  coverage,
  listing,
  onClickCapture,
  onKeyDown,
  upcoming = false,
}: {
  rail: boolean;
  /** The Upcoming view: its rows carry longer state names. */
  upcoming?: boolean;
  bar: ReactNode;
  summary: ReactNode;
  coverage: ReactNode;
  listing: ReactNode;
  onClickCapture?(): void;
  onKeyDown?(event: KeyboardEvent): void;
}) {
  return (
    <section
      className={styles.page}
      data-rail={rail ? '' : undefined}
      aria-label="Translation queue"
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
    >
      <div className={styles.controls}>
        <div className={styles.bar}>
          <h1>Translations</h1>
          {bar}
        </div>
        {summary && <div className={styles.summary}>{summary}</div>}
      </div>
      <div className={styles.body}>
        {coverage}
        <div className={styles.listing} data-upcoming={upcoming ? '' : undefined}>
          {listing}
        </div>
      </div>
    </section>
  );
}

/** Current | Upcoming, beside the heading (its own full-width line on phones). */
function SourceSwitch({
  source,
  onSource,
}: {
  source: TranslationsSource;
  onSource(source: TranslationsSource): void;
}) {
  return (
    <div className={styles.sourceSwitch} role="group" aria-label="Translations to show">
      {(['current', 'upcoming'] as const).map((value) => (
        <button
          key={value}
          type="button"
          data-perf-navigation="true"
          aria-pressed={source === value}
          title={
            value === 'current'
              ? 'Translations of the saved English'
              : 'Translations of English that open scheduled batches change'
          }
          onClick={() => onSource(value)}
        >
          {value === 'current' ? 'Current' : 'Upcoming'}
        </button>
      ))}
    </div>
  );
}

/** What the Upcoming view gets from the page: the URL state, the shared controls, and actions. */
export interface UpcomingPageProps {
  language: Lang | undefined;
  available: readonly Lang[];
  translator: boolean;
  /** The requested language is not one of the reader's (it shows the first available instead). */
  unavailable: string | null;
  category: string | null;
  query: string;
  text: string;
  setText(text: string): void;
  deferredText: string;
  stateParam: string | null;
  /** The row whose read-only batch view is open (`?open=<batchId>:<hash>`), if any. */
  opened: string | null;
  phone: boolean;
  update(changes: Record<string, string | null>, push?: boolean): void;
  onPick(language: Lang): void;
  coverageOpen: boolean;
  setCoverageOpen(open: boolean): void;
  /** The language picker (or the fixed language), as the Current queue shows it. */
  languageControl: ReactNode;
  sourceSwitch: ReactNode;
  /** The filter field, with the view's own Enter handler. */
  filterField(onKeyDown: (event: KeyboardEvent) => void): ReactNode;
  onClickCapture(): void;
  onKeyDown(event: KeyboardEvent): void;
}

function Coverage({
  index,
  languages,
  language,
  scope,
  open,
  onPick,
}: {
  index: TranslationIndex;
  languages: readonly Lang[];
  language: Lang;
  /** The category filter, when it names a translatable category: counts cover only it. */
  scope: { id: string; label: string } | undefined;
  open: boolean;
  onPick(language: Lang): void;
}) {
  const scopeLabel = scope ? `${scope.label} only` : 'All categories';
  return (
    <div
      id="translation-coverage"
      className={styles.coverage}
      data-open={open ? '' : undefined}
      role="group"
      aria-label={`Coverage by language, ${scopeLabel.toLowerCase()}`}
    >
      <div className={styles.coverageTop} aria-hidden="true">
        <div className={styles.coverageScope} title={scopeLabel}>
          {scopeLabel}
        </div>
        <div className={styles.coverageHead}>
          <span>Language</span>
          <span>Translated</span>
          <span>Outdated</span>
          <span>Missing</span>
        </div>
      </div>
      {languages.map((lang) => {
        const { translated, outdated, missing } = index.coverage(lang, scope?.id);
        return (
          <button
            key={lang}
            type="button"
            data-perf-navigation="true"
            aria-pressed={lang === language}
            aria-label={`${languageLabel(lang)}: ${translated} translated, ${outdated} outdated, ${missing} missing`}
            onClick={() => onPick(lang)}
          >
            <span>{languageLabel(lang)}</span>
            <span>{translated}</span>
            <span data-zero={outdated ? undefined : ''}>{outdated}</span>
            <span data-zero={missing ? undefined : ''}>{missing}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TranslationsPage() {
  useLeftQueue();
  const data = useDataStore((state) => state.data);
  const { user, loading } = useAuthStore();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const available = useMemo(() => availableLanguages(user), [user]);
  const requested = params.get('lang');
  const language: Lang | undefined = available.find((lang) => lang === requested) ?? available[0];
  const state = parseStateFilter(params.get('state'));
  const category = params.get('cat');
  const query = params.get('q') ?? '';
  const [text, setText] = useState(query);
  const deferredText = useDeferredValue(text);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const phone = useMedia(phoneQuery);
  // Leave from the editor's queue brings the list's position and selected row back.
  const returned = returnedState<TranslationsRestore>(useLocation().state);
  // The queue a row opens: its id rides in the row link's state, and the queue itself starts in
  // the click, with the rows shown at that moment (frozen from then on).
  const [pendingId] = useState(newQueueId);
  // Upcoming (scheduled changes) only in a switch-ON build, for roles that may read batches.
  const batchesAllowed =
    import.meta.env.VITE_SCHEDULED_ENABLED === '1' &&
    user?.role != null &&
    batchRoles.has(user.role);
  // A link to an opened Upcoming row (reload, Back from elsewhere) shows the Upcoming view.
  const [chosenSource, setChosenSource] = useState<TranslationsSource>(() => {
    if (params.get('open') || params.get('upcoming') === '1') rememberedSource = 'upcoming';
    return rememberedSource;
  });
  const source: TranslationsSource = batchesAllowed ? chosenSource : 'current';

  // The URL is the source of truth; typing is debounced into it so every key is not a navigation.
  useEffect(() => setText(query), [query]);
  const update = (changes: Record<string, string | null>, push = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: !push });
  };
  const commitText = () => {
    const next = new URLSearchParams(params);
    if (text) next.set('q', text);
    else next.delete('q');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(commitText, searchDelayMs);
    return () => clearTimeout(timer);
    // commitText closes over the same values as the dependencies below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, query, params, setParams]);

  const index = useMemo(() => (data ? translationIndex(data) : null), [data]);
  const rows = (index && language && index.queue(language)) || noRows;
  const categories = useMemo(
    () => (index ? categoryOptions(rows, index.categories) : []),
    [rows, index],
  );
  // The same list, in the same order, that the editor's queue control steps through.
  const shownFilters = useMemo(
    () => ({ state, category, query: deferredText }),
    [state, category, deferredText],
  );
  const shown = useMemo(
    () => (index && language ? queueFor(index, language, shownFilters) : noRows),
    [index, language, shownFilters],
  );
  // A row opens the editor in queue mode for this view (an override opens on its base's page).
  const linkTo = useCallback(
    (row: QueueRow) => ({
      to: entryPath(row, data ? canonicalHash(row.hash, data) : row.hash),
      state: visitState({ id: pendingId, key: row.key }),
    }),
    [data, pendingId],
  );
  const startAt = useCallback(
    (
      first: QueueRow,
      filters: QueueFilters,
      rows: readonly QueueRow[],
      top: number,
      id?: string,
    ) => {
      const view = { language: language!, ...filters };
      const categoryLabel = (id: string) =>
        index?.categories.find((entry) => entry.id === id)?.label ?? id;
      return startQueue({
        id,
        source: 'translations',
        scope: 'shown',
        items: rows.map((row) => translationItem(row, data!)),
        first: translationItem(first, data!),
        origin: {
          path: queuePath(view, user),
          restore: {
            ...view,
            top,
            selectedRow: first.key,
            summary: queueSummary(view, languageLabel, categoryLabel),
          } satisfies TranslationsRestore,
        },
      });
    },
    [language, index, data, user],
  );
  const onOpen = useCallback(
    (row: QueueRow, top: number) => startAt(row, shownFilters, shown, top, pendingId),
    [startAt, shownFilters, shown, pendingId],
  );
  // The state buttons count what the category filter leaves, like the coverage table.
  const counts = useMemo(
    () => countRows(category ? filterRows(rows, { state: null, category, query: '' }) : rows),
    [rows, category],
  );

  const showSkeleton = useSkeletonVisible(loading || !index, 'queue', false);
  if (loading || !index || showSkeleton) return <Loading />;

  const translator = user?.role === 'translator';
  const coverage = !translator && available.length > 0;
  const signature = `${language}|${state}|${category}|${deferredText}`;
  const filtered = !!(state || category || query);
  const unavailable = !!requested && requested !== 'all' && requested !== language;
  const openFirst = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // The first match of what is typed now, not of the deferred list.
    const first = filterRows(rows, { state, category, query: text })[0];
    if (!first) return;
    // Back must return to this filter, so it is in the URL before the editor opens.
    if (text !== query) commitText();
    rememberOpenedFirst(`${language}|${state}|${category}|${text}`, first.key);
    const filters = { state, category, query: text };
    const { to, state: visit } = startAt(first, filters, filterRows(rows, filters), 0);
    void navigate(to, { state: visit });
  };
  const pick = (lang: Lang) => {
    setCoverageOpen(false);
    update({ lang: lang === available[0] ? null : lang, cat: null }, true);
  };
  const chooseSource = (next: TranslationsSource) => {
    if (next === source) return;
    rememberedSource = next;
    setChosenSource(next);
    setCoverageOpen(false);
    // Each view has its own state filter; the language, category, and text carry over.
    if (params.get('state') || params.get('open')) update({ state: null, open: null });
  };

  // Phones: language, category, and the count on the first line; the filter, the state pair, and
  // Coverage on the second. On a 390 px phone the count moves to the end (see .controls).
  const renderFilter = (onKeyDown: (event: KeyboardEvent) => void) => (
    <input
      type="search"
      aria-label="Filter by name, hash, or category"
      placeholder={phone ? 'Filter' : 'Filter name, hash, or category'}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
  const filterField = renderFilter(openFirst);
  const languageControl = (
    <>
      {language && available.length > 1 && (
        <label className={styles.languagePicker}>
          <span className="sr-only">Language</span>
          <select
            data-perf-navigation="true"
            value={language}
            onChange={(event) => pick(event.target.value as Lang)}
          >
            {available.map((lang) => (
              <option key={lang} value={lang}>
                {languageLabel(lang)}
              </option>
            ))}
          </select>
        </label>
      )}
      {language && available.length === 1 && (
        <span className={styles.fixedLanguage}>{languageLabel(language)}</span>
      )}
    </>
  );
  const sourceSwitch = batchesAllowed ? (
    <SourceSwitch source={source} onSource={chooseSource} />
  ) : null;
  const onClickCapture = () => {
    // Opening a row inside the typing debounce must not lose the filter on Back.
    if (text !== query) commitText();
  };
  const onFrameKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && coverageOpen) setCoverageOpen(false);
  };

  if (import.meta.env.VITE_SCHEDULED_ENABLED === '1' && source === 'upcoming')
    return (
      <Suspense fallback={<Loading />}>
        <UpcomingTranslations
          language={language}
          available={available}
          translator={translator}
          unavailable={unavailable ? requested : null}
          category={category}
          query={query}
          text={text}
          setText={setText}
          deferredText={deferredText}
          stateParam={params.get('state')}
          opened={params.get('open')}
          phone={phone}
          update={update}
          onPick={pick}
          coverageOpen={coverageOpen}
          setCoverageOpen={setCoverageOpen}
          languageControl={languageControl}
          sourceSwitch={sourceSwitch}
          filterField={renderFilter}
          onClickCapture={onClickCapture}
          onKeyDown={onFrameKeyDown}
        />
      </Suspense>
    );

  const countLine = (
    <span className={styles.count} role="status">
      {filtered ? `${shown.length} of ${rows.length}` : `${rows.length} to translate`}
    </span>
  );
  return (
    <TranslationsFrame
      rail={coverage}
      onClickCapture={onClickCapture}
      onKeyDown={onFrameKeyDown}
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
              {!phone && filterField}
              {phone && countLine}
            </>
          )}
        </>
      }
      summary={
        language && (
          <>
            {phone && filterField}
            <div role="group" aria-label="Show">
              {(['outdated', 'missing'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-perf-navigation="true"
                  aria-pressed={state === value}
                  onClick={() => update({ state: state === value ? null : value })}
                >
                  {value === 'outdated' ? 'Outdated' : 'Missing'} {counts[value]}
                </button>
              ))}
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
          <Coverage
            index={index}
            languages={available}
            language={language}
            scope={category ? index.categories.find((option) => option.id === category) : undefined}
            open={coverageOpen}
            onPick={pick}
          />
        )
      }
      listing={
        <>
          {unavailable && (
            <p className={styles.empty} role="status">
              {languageLabel(requested)} is not one of your assigned languages. Showing{' '}
              {language ? languageLabel(language) : 'nothing'}.
            </p>
          )}
          {!language ? (
            <p className={styles.empty}>
              {translator
                ? 'You have no assigned languages, so there is nothing to translate.'
                : 'No languages to translate.'}
            </p>
          ) : shown.length ? (
            <QueueList
              key={signature}
              signature={signature}
              rows={shown}
              linkTo={linkTo}
              onOpen={onOpen}
              restored={
                returned &&
                `${returned.language}|${returned.state}|${returned.category}|${returned.query}` ===
                  signature
                  ? { top: returned.top, selected: returned.selectedRow }
                  : undefined
              }
              label={`${languageLabel(language)} tooltips to translate`}
            />
          ) : (
            <p className={styles.empty} role="status">
              {filtered
                ? 'No tooltips match these filters.'
                : `Nothing to translate in ${languageLabel(language)}.`}
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
