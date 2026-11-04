import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveAlias } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { canEditTooltipFields } from '../auth/permissions';
import { canonicalHash, itemFor, tooltipFor } from '../navigation/catalog';
import { GlobalUsageSummary } from '../globals/GlobalsPage';
import { associationCandidates, moveAssociation } from './associations';
import { PanelRow } from '../../ui/PanelRow';
import styles from './AssociationsPanel.module.scss';

export function AssociationsPanel({
  hash,
  suspended = false,
}: {
  hash: number;
  suspended?: boolean;
}) {
  const data = useDataStore((state) => state.data);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const user = useAuthStore((state) => state.user);
  const saving = useSaveState((state) => state.locked);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const tooltip = data ? (draft?.next ?? tooltipFor(hash, data)) : undefined;
  const membership = tooltip?.associated.join(',') ?? '';
  const associated = useMemo(
    () => (membership ? membership.split(',').map(Number) : []),
    [membership],
  );
  const editable = Boolean(apiUrl && hydrated && !saving && canEditTooltipFields(user));
  const candidates = useMemo(
    // PanelRow does not mount its body while collapsed. Do not scan and sort the entire
    // catalogue on every item switch or keystroke for a picker that is not being shown.
    () =>
      !suspended && open && adding && editable && data
        ? associationCandidates(data, query, hash, associated)
        : [],
    [suspended, open, adding, editable, data, associated, query, hash],
  );
  if (!data || !tooltip) return null;
  function change(associated: number[]) {
    if (!editable || !data) return;
    updateDraft(tooltipFor(hash, data), (next) => ({ ...next, associated }));
  }
  const names = tooltip.associated.map(
    (associated) =>
      itemFor(resolveAlias(associated, data.aliases), data)?.name ?? `Tooltip ${associated}`,
  );
  return (
    <section aria-label={`Associations for ${hash}`} className={styles.panel}>
      <PanelRow
        label={`Associated tooltips (${tooltip.associated.length})`}
        open={open}
        onOpenChange={setOpen}
        summary={names.join(' · ')}
        actions={
          editable && (
            <button
              type="button"
              aria-label="Add associated tooltip"
              onClick={() => {
                setOpen(true);
                setAdding(true);
              }}
            >
              Add
            </button>
          )
        }
      >
        {(hash === 2 || hash === 3) && <GlobalUsageSummary hash={hash} />}
        <p className={styles.hint}>Shown in this order as expandable entries in the preview.</p>
        {!tooltip.associated.length && <p>No associated tooltips.</p>}
        <ol className={styles.selected}>
          {tooltip.associated.map((associated, index) => {
            const target = resolveAlias(associated, data.aliases);
            const entry = itemFor(target, data);
            return (
              <li key={`${associated}:${index}`}>
                {entry?.icon && <img src={`https://www.bungie.net${entry.icon}`} alt="" />}
                <Link to={`/t/${canonicalHash(target, data)}`}>
                  {entry?.name ?? `Tooltip ${target}`}
                </Link>
                {editable && (
                  <span className={styles.actions}>
                    <button
                      type="button"
                      aria-label={`Move ${entry?.name ?? target} up`}
                      disabled={index === 0}
                      onClick={() => change(moveAssociation(tooltip.associated, index, -1))}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${entry?.name ?? target} down`}
                      disabled={index === tooltip.associated.length - 1}
                      onClick={() => change(moveAssociation(tooltip.associated, index, 1))}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${entry?.name ?? target}`}
                      onClick={() =>
                        change(tooltip.associated.filter((_, position) => position !== index))
                      }
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {editable
          ? adding && (
              <div>
                <label>
                  Search name or hash{' '}
                  <input
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <p>
                  {candidates.length} matches
                  {candidates.length > 30 && ' (showing the first 30; narrow your search)'}
                </p>
                <ul className={styles.results}>
                  {candidates.slice(0, 30).map((target) => (
                    <li key={target}>
                      <button type="button" onClick={() => change([...tooltip.associated, target])}>
                        Add {itemFor(target, data)?.name ?? `Tooltip ${target}`} ({target})
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          : user?.role !== 'translator' && (
              <p>
                {saving
                  ? 'Finish the open save review before editing associations.'
                  : 'Association editing requires an editor account and a connected API.'}
              </p>
            )}
      </PanelRow>
    </section>
  );
}
