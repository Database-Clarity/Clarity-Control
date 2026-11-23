import { useEffect, useRef, useState } from 'react';
import { sharedSandboxPerks, type AliasGroupsResponse } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { getAliasGroups, removeGroupMember } from '../../services/aliasGroups';
import { useAuthStore } from '../../stores/auth';
import { applyAliasGroups, useDataStore } from '../../stores/data';
import { Popover } from '../../ui/Popover';
import styles from './InactiveMoveControl.module.scss';

/**
 * Maintainers take one non-canonical member out of its accepted group, with an in-place confirm.
 * A member whose sandbox perk another inventory item shares stays grouped (owner 2026-11-23);
 * the row says so instead of offering the action, and the Worker refuses it the same way.
 */
export function GroupRemoveControl({
  hash,
  name,
  className,
}: {
  hash: number;
  name: string;
  className?: string;
}) {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const data = useDataStore((state) => state.data);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<AliasGroupsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const canonical = data?.aliases[hash]?.kind === 'name' ? data.aliases[hash]!.to : undefined;
  const group = canonical === undefined ? undefined : data?.bundle.aliasGroups?.groups[canonical];
  const allowed =
    !!apiUrl &&
    user?.role === 'maintainer' &&
    !!group?.members.includes(hash) &&
    hash !== canonical;
  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!open || !allowed) return;
    const abort = new AbortController();
    void getAliasGroups(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setLoaded(value);
      },
      (reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Cannot load alias groups');
      },
    );
    return () => abort.abort();
  }, [open, allowed, hash, token]);
  useEffect(() => {
    setOpen(false);
  }, [hash, user, token]);
  if (!allowed || !data || canonical === undefined) return null;
  const shared = sharedSandboxPerks(
    hash,
    data.items,
    data.generatorAliases ?? data.aliases,
    data.sandboxConflicts ?? {},
  );
  if (shared.length)
    return (
      <span title={`Sandbox perk ${shared.join(', ')} is shared with another inventory item`}>
        Stays grouped: shared sandbox perk
      </span>
    );
  const save = async () => {
    if (!loaded || savingRef.current) return;
    const identity = useAuthStore.getState();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await removeGroupMember(loaded.head, canonical, hash);
      const current = useAuthStore.getState();
      if (current.user !== identity.user || current.token !== identity.token) return;
      // The removal is saved from here on: nothing below may report it as failed.
      setOpen(false);
      const source = useDataStore.getState().data?.bundle.tooltips[canonical];
      applyAliasGroups(result.config, source && { ...structuredClone(source), hash });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Cannot remove from group');
      // A conflict requires closing and reopening for a fresh head and confirmation.
      setLoaded(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const label = 'Remove from group';
  return (
    <Popover
      label={label}
      trigger={label}
      triggerLabel={label}
      triggerTitle={label}
      open={open}
      onOpenChange={setOpen}
      contain
      width={360}
      className={className}
    >
      {(close) => (
        <div className={styles.confirm}>
          <strong>Remove {name.trim() || `Tooltip ${hash}`} from the group?</strong>
          <p>
            It becomes its own entry and starts with a copy of the group's text in every language.
            Its sandbox perks stay with it. Automatic grouping will not add it back.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error.replace(/[.!?]?$/, '.')} Close and reopen to reload, then try again.
            </p>
          )}
          {!loaded && !error && <p role="status">Loading current groups…</p>}
          <div className={styles.actions}>
            <button type="button" data-autofocus onClick={() => close()}>
              Cancel
            </button>
            <button type="button" disabled={!loaded || saving} onClick={() => void save()}>
              {saving ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
