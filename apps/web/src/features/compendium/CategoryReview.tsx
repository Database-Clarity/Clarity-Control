import { guidanceDiagnostic } from './guidanceDiagnostic';
import { useEffect, useMemo, useState } from 'react';
import { matchingSession } from './matchingSession';
import type { GuidedCategory } from './guidedDecisions';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import { reasonLabels, type ReviewCategory } from './reviewCategories';
import type { useGuidance } from './useGuidance';
import { referenceCurrent } from './sampleReferences';
import { SampleReview } from './SampleReview';
import { SendGuidance } from './SendGuidance';
import styles from './CategoryReview.module.scss';
import { GuidedPreview } from './GuidedPreview';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { sourceFingerprint } from './reviewProgress';
import { inScopeCategory } from './reviewScope';
import { previousCategoryLabel } from '../../services/categoryLabels';

export type CategoryReviewRouteState = {
  query: string;
  categoryId: string;
  selectedSamples: Record<string, number>;
  onQueryChange: (query: string) => void;
  onCategorySelect: (categoryId: string) => void;
  onSampleSelect: (categoryId: string, hash: number) => void;
};

export function CategoryReview({
  categories,
  editor,
  source,
  proposals,
  guidance,
  onReview,
  routeState,
  canEdit = false,
  onAccept,
  onRestore,
  fingerprint: inputFingerprint,
  includedHashes,
}: {
  fingerprint?: string;
  includedHashes?: Set<number>;
  onRestore?: (hash: number) => void;
  categories: ReviewCategory[];
  editor: EditorData;
  source: CompendiumData;
  proposals: Map<number, ReviewProposal>;
  guidance: ReturnType<typeof useGuidance>;
  canEdit?: boolean;
  routeState?: CategoryReviewRouteState;
  onAccept?: (
    category: ReviewCategory,
    entries: import('./guidedDecisions').GuidedDecision[],
    revision: string,
  ) => void;
  onReview: (category?: ReviewCategory, hash?: number) => void;
}) {
  const fingerprint = useMemo(
    () => inputFingerprint ?? sourceFingerprint(source.tabs),
    [inputFingerprint, source],
  );
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState('');
  const [localCategoryId, setLocalCategoryId] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [browsing, setBrowsing] = useState(20);
  const [importError, setImportError] = useState<string | null>(null);
  const query = routeState?.query ?? localQuery;
  const categoryId = routeState?.categoryId ?? localCategoryId;
  const scopedCategories = useMemo(
    () =>
      categories.map((category) => {
        if (!includedHashes) return inScopeCategory(category);
        const included = (entry: ReviewCategory['entries'][number]) =>
          includedHashes.has(entry.hash);
        return {
          ...category,
          entries: category.entries.filter(included),
          samples: category.samples.filter(included),
          reasons: Object.fromEntries(
            Object.entries(category.reasons).map(([reason, entries]) => [
              reason,
              entries.filter(included),
            ]),
          ) as ReviewCategory['reasons'],
        };
      }),
    [categories, includedHashes],
  );
  const filtered = useMemo(
    () =>
      scopedCategories.filter((category) =>
        `${category.name} ${category.group} ${previousCategoryLabel(
          decodeURIComponent(category.id.replace(/^catalog:/, '')),
        )}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [scopedCategories, query],
  );
  const category = filtered.find((category) => category.id === categoryId) ?? filtered[0];
  const activeCategoryId = category?.id ?? '';
  const [computed, setComputed] = useState<{
    input: typeof guidance.proposalInput;
    categories: typeof categories;
    categoryId: string;
    groups: GuidedCategory[];
  }>();
  useEffect(() => {
    if (typeof Worker === 'undefined' || !guidance.proposalInput) return;
    let cancelled = false;
    const input = guidance.proposalInput;
    void matchingSession(editor, source)
      .guided(
        input,
        categories,
        `${editor.bundle.sourceCommit}|${fingerprint}`,
        `${bundleUrl}|${compendiumDataUrl}`,
        activeCategoryId,
      )
      .then((groups) => {
        if (!cancelled) setComputed({ input, categories, categoryId: activeCategoryId, groups });
      })
      .catch(() => {
        if (!cancelled)
          setComputed({ input, categories, categoryId: activeCategoryId, groups: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [editor, source, categories, guidance.proposalInput, fingerprint, activeCategoryId]);
  const computedGroups =
    typeof Worker === 'undefined'
      ? undefined
      : computed &&
          computed.input === guidance.proposalInput &&
          computed.categories === categories &&
          computed.categoryId === activeCategoryId
        ? computed.groups
        : [];
  const sampleIndex = useMemo(
    () =>
      new Map(
        scopedCategories.map((group) => {
          const references = guidance.document.categories[group.id]?.references ?? {};
          const sampleHashes = new Set(group.samples.map((sample) => sample.hash));
          const entries = [
            ...group.samples,
            ...group.entries.filter(
              (entry) => references[entry.hash] && !sampleHashes.has(entry.hash),
            ),
          ];
          const resolved = entries.filter((entry) => {
            const reference = references[entry.hash];
            return (
              reference?.decision &&
              reference.decision !== 'skipped' &&
              referenceCurrent(reference, entry, guidance.document.baseline, source)
            );
          }).length;
          return [group.id, { entries, resolved }] as const;
        }),
      ),
    [scopedCategories, guidance.document, source],
  );
  const entries = category ? sampleIndex.get(category.id)!.entries : [];
  const selectedHash = routeState
    ? category && routeState.selectedSamples[category.id]
    : selected[category?.id ?? ''];
  const entry = entries.find((entry) => entry.hash === selectedHash) ?? entries[0];
  const paused = !guidance.ready || guidance.reloading;
  function exportGuidance() {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(guidance.document, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'review-guidance.json';
      link.click();
      setImportError(null);
    } catch (error) {
      setImportError(`Backup export failed: ${guidanceDiagnostic(error)}. Keep this page open.`);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  return (
    <section className={styles.categories} aria-label="Category guidance">
      <div className={styles.intro}>
        <div>
          <h2>Resolve a few examples</h2>
          <p>Agents use your examples to match the rest. References only; no tooltip saves.</p>
        </div>
        <button onClick={() => onReview()}>Review all one by one</button>
      </div>
      <div className={styles.persistence}>
        <p role="status">
          {guidance.localError
            ? 'Browser backup needs attention'
            : (deliveryStatus ??
              (!guidance.ready
                ? 'Loading guidance…'
                : guidance.reloading
                  ? 'Reloading guidance…'
                  : guidance.saving
                    ? 'Saving to dev disk…'
                    : guidance.localError
                      ? 'Browser backup needs attention'
                      : guidance.error || guidance.conflict
                        ? 'Guidance needs attention'
                        : guidance.diskSaved
                          ? 'Saved to dev disk'
                          : guidance.browserSaved
                            ? 'Saved in this browser'
                            : 'Browser guidance not saved yet'))}
        </p>
        <details>
          <summary>Details</summary>
          <p>
            Examples and notes stay in this browser. Send to agents confirms delivery separately;
            export keeps a portable backup.
          </p>
          {guidance.error && <p role="alert">{guidance.error}</p>}
          {guidance.renewalNotice && <p role="status">{guidance.renewalNotice}</p>}
          {guidance.localError && <p role="alert">{guidance.localError}</p>}
          <SendGuidance
            document={guidance.document}
            ready={guidance.ready}
            onStatus={setDeliveryStatus}
            onSend={() => guidance.persistence.save()}
          />
          <details>
            <summary>Backup / recovery</summary>
            <div>
              <button onClick={exportGuidance} disabled={!guidance.ready}>
                Export backup
              </button>
              <label>
                Import guidance backup
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={paused || guidance.saving || guidance.conflict}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (
                      !window.confirm(
                        'Replace browser examples and notes with this backup? Export a backup first to keep the current guidance.',
                      )
                    )
                      return;
                    try {
                      const raw = await file.text();
                      // A reload, edit or save while reading must not be overwritten.
                      if (guidance.persistence.getSnapshot().document !== guidance.document)
                        throw new Error('Guidance changed while reading the backup. Import again.');
                      guidance.persistence.importBackup(JSON.parse(raw));
                      setImportError(null);
                    } catch (error) {
                      setImportError(guidanceDiagnostic(error));
                    }
                  }}
                />
              </label>
              {importError && <p role="alert">{importError}</p>}
              {guidance.diskAvailable &&
                guidance.error &&
                !guidance.conflict &&
                !guidance.reloading && (
                  <button
                    onClick={() => {
                      guidance.persistence.save();
                      void guidance.persistence.flush();
                    }}
                  >
                    Retry disk save
                  </button>
                )}
              {guidance.diskAvailable && (
                <button
                  disabled={!guidance.ready || guidance.saving || guidance.reloading}
                  onClick={() => {
                    if (
                      guidance.diskSaved ||
                      window.confirm(
                        'Discard unsaved browser examples and notes and reload disk? Export a backup first to keep them.',
                      )
                    )
                      void guidance.persistence.reloadDisk();
                  }}
                >
                  Reload disk guidance
                </button>
              )}
            </div>
          </details>
        </details>
      </div>
      <div className={styles.workspace}>
        <nav className={styles.categoryList} aria-label="Review categories">
          <label>
            Find category
            <input
              size={1}
              value={query}
              onChange={(event) => {
                if (routeState) routeState.onQueryChange(event.target.value);
                else setLocalQuery(event.target.value);
              }}
              placeholder="Weapons, armor, subclass..."
            />
          </label>
          {!categories.length && <p>No entries need category guidance.</p>}
          {categories.length > 0 && !filtered.length && <p>No categories match your search.</p>}
          <div className={styles.categoryButtons}>
            {filtered.map((group) => (
              <button
                key={group.id}
                aria-current={group.id === category?.id ? 'true' : undefined}
                onClick={() => {
                  if (routeState) routeState.onCategorySelect(group.id);
                  else setLocalCategoryId(group.id);
                  setBrowsing(20);
                }}
              >
                <strong>{group.name}</strong>
                <small>
                  {sampleIndex.get(group.id)!.resolved}/{sampleIndex.get(group.id)!.entries.length}{' '}
                  samples resolved · {group.entries.length} entries
                </small>
              </button>
            ))}
          </div>
        </nav>
        {category && (
          <section className={styles.category} aria-label={category.name}>
            <header>
              <h3>{category.name}</h3>
              <span>
                {sampleIndex.get(category.id)!.resolved}/{entries.length} samples resolved
              </span>
            </header>
            <div className={styles.sampleTabs} aria-label="Representative samples">
              {entries.map((sample, index) => (
                <button
                  key={sample.hash}
                  aria-pressed={sample.hash === entry?.hash}
                  onClick={() => {
                    if (routeState) routeState.onSampleSelect(category.id, sample.hash);
                    else setSelected((state) => ({ ...state, [category.id]: sample.hash }));
                  }}
                >
                  {index + 1}. {sample.name}
                </button>
              ))}
            </div>
            {entry && (
              <SampleReview
                key={`${category.id}:${entry.hash}`}
                entry={entry}
                category={category}
                editor={editor}
                source={source}
                proposal={proposals.get(entry.hash)}
                guidance={guidance}
              />
            )}
            <details className={styles.categoryNote}>
              <summary>Owner guidance for {category.name}</summary>
              <label>
                Owner guidance for {category.name}
                <textarea
                  rows={2}
                  maxLength={100_000}
                  disabled={paused}
                  value={guidance.document.categories[category.id]?.comment ?? ''}
                  placeholder="Any rule agents should use for this category?"
                  onChange={(event) =>
                    guidance.persistence.comment(category.id, event.target.value)
                  }
                  onBlur={() => void guidance.persistence.flush()}
                />
              </label>
            </details>
            <details className={styles.browse}>
              <summary>Browse / category definition ({category.entries.length} entries)</summary>
              <p>{category.rule}</p>
              <p>
                {Object.entries(category.reasons)
                  .filter(([, entries]) => entries.length)
                  .map(
                    ([reason, entries]) =>
                      `${reasonLabels[reason as keyof typeof reasonLabels]}: ${entries.length}`,
                  )
                  .join(' · ')}
              </p>
              {category.entries.slice(0, browsing).map((entry) => (
                <button key={entry.hash} onClick={() => onReview(category, entry.hash)}>
                  {entry.name} · {entry.hash}
                </button>
              ))}
              {browsing < category.entries.length && (
                <button onClick={() => setBrowsing(browsing + 20)}>Show 20 more</button>
              )}
            </details>
            <button onClick={() => onReview(category)}>Review these one by one</button>
            {guidance.ready && guidance.proposalInput && (
              <GuidedPreview
                computedGroups={computedGroups}
                categories={categories}
                key={category.id}
                canEdit={canEdit && !paused && !guidance.conflict && !guidance.reloading}
                onRestore={onRestore}
                onAccept={(entries, revision) => onAccept?.(category, entries, revision)}
                document={guidance.proposalInput}
                planningRevision={guidance.planningRevision}
                category={category}
                proposals={proposals}
                source={source}
                baseline={`${editor.bundle.sourceCommit}|${fingerprint}`}
                scope={`${bundleUrl}|${compendiumDataUrl}`}
              />
            )}
          </section>
        )}
      </div>
    </section>
  );
}
