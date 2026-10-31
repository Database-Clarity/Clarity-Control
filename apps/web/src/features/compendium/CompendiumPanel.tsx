import { useEffect, useState } from 'react';
import { resolveCompendiumLink, snapshotCompendium, type Tooltip } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { apiUrl } from '../../services/api';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { itemFor } from '../navigation/catalog';
import { CompendiumDiff } from './CompendiumDiff';
import { RichCell } from './RichCell';
import { LinkPicker } from './LinkPicker';
import { useCompendiumStore } from './store';
import styles from './Compendium.module.scss';
import { confirmCompendiumSelection } from './selection';

export function CompendiumPanel({ base }: { base: Tooltip }) {
  const { data: compendium, loading, error, load } = useCompendiumStore();
  const data = useDataStore((state) => state.data);
  const draft = useDraftStore((state) => state.drafts[base.hash]);
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const hydrated = useDraftStore((state) => state.hydrated);
  const user = useAuthStore((state) => state.user);
  const saving = useSaveState((state) => state.locked);
  const [picking, setPicking] = useState(false);
  const tooltip = draft?.next ?? base;
  const link = tooltip.compendium;
  const canEdit =
    !!apiUrl &&
    hydrated &&
    !saving &&
    !!user?.role &&
    ['maintainer', 'editor', 'trial'].includes(user.role);
  const canReview =
    !!apiUrl && hydrated && !saving && !!user?.role && ['maintainer', 'editor'].includes(user.role);
  useEffect(() => {
    void load();
  }, [load]);
  const resolution = compendium && link ? resolveCompendiumLink(link, compendium) : undefined;
  const match =
    resolution && ['ok', 'changed', 'moved'].includes(resolution.status) && 'row' in resolution
      ? resolution
      : undefined;
  const item = data && itemFor(base.hash, data);
  return (
    <aside className={styles.panel} aria-label={`Compendium for ${item?.name ?? base.hash}`}>
      <h3>Compendium</h3>
      {loading && <p role="status">Loading Compendium...</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load(true)}>
            Retry
          </button>
        </p>
      )}
      {compendium && (
        <small>Source fetched {new Date(compendium.fetchedAt).toLocaleString()}</small>
      )}
      {!link && <p>No Compendium row linked yet.</p>}
      {link && (
        <>
          <p>
            {link.rowKey} {link.section && `/ ${link.section}`} / tab {link.gid}
          </p>
          <small>Snapshot {new Date(link.snapshotAt).toLocaleString()}</small>
          {match && (
            <>
              <p className={match.status === 'ok' ? undefined : styles.warning}>
                {match.status === 'moved'
                  ? `Moved to ${match.tab.name} / ${match.row.name}; follows automatically and is saved on the next English save or review.`
                  : match.status === 'changed'
                    ? 'Compendium text or styling has changed.'
                    : 'Matches the saved snapshot.'}
              </p>
              <a
                href={`https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview#gid=${match.tab.gid}`}
                target="_blank"
                rel="noreferrer"
              >
                Open source tab
              </a>
              <CompendiumDiff before={link.snapshot} after={match.row.cell} />
              {canReview && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={!!draft || match.status === 'ok'}
                    onClick={() => {
                      reviewSaveChanges([
                        {
                          hash: base.hash,
                          base,
                          next: { ...base, compendium: snapshotCompendium(match) },
                        },
                      ]);
                    }}
                  >
                    Mark as reviewed
                  </button>
                  {draft && (
                    <small>Save or discard this tooltip's draft before marking reviewed.</small>
                  )}
                </div>
              )}
            </>
          )}
          {resolution?.status === 'candidates' && (
            <>
              <p className={styles.warning}>
                Needs relink: the old name is ambiguous or missing. Confirm a suggested row or
                search.
              </p>
              <ul className={styles.rows}>
                {resolution.candidates.map((candidate) => (
                  <li key={`${candidate.tab.gid}:${candidate.row.rowIndex}`}>
                    <p>
                      {candidate.tab.name} / {candidate.row.name}{' '}
                      {candidate.row.section && `/ ${candidate.row.section}`} (
                      {Math.round(candidate.similarity * 100)}% content match)
                    </p>
                    <div className={styles.cell}>
                      <RichCell cell={candidate.row.cell} />
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        disabled={!compendium || !confirmCompendiumSelection(candidate, compendium)}
                        onClick={() => {
                          if (!compendium) return;
                          const confirmed = confirmCompendiumSelection(candidate, compendium);
                          if (!confirmed) return;
                          updateDraft(base, (tooltip) => ({
                            ...tooltip,
                            compendium: confirmed,
                          }));
                        }}
                      >
                        Link this row
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {resolution?.status === 'missing' && (
            <p className={styles.warning}>
              Needs relink: no matching row or similar content found.
            </p>
          )}
          {!match && (
            <div className={styles.cell}>
              <RichCell cell={link.snapshot} />
            </div>
          )}
        </>
      )}
      {canEdit && (
        <div className={styles.actions}>
          <button type="button" onClick={() => setPicking(!picking)}>
            {picking
              ? 'Close row picker'
              : link
                ? 'Pick description cells / relink'
                : 'Link a row / pick description cells'}
          </button>
          {link && (
            <button
              type="button"
              onClick={() =>
                updateDraft(base, (tooltip) => {
                  const next = { ...tooltip };
                  delete next.compendium;
                  return next;
                })
              }
            >
              Unlink (local draft)
            </button>
          )}
        </div>
      )}
      {picking && canEdit && (
        <LinkPicker
          base={base}
          name={item?.name ?? base.custom?.name ?? ''}
          category={item?.categoryId ?? 'other'}
          onLinked={() => setPicking(false)}
        />
      )}
    </aside>
  );
}
