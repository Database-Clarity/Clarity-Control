import { useEffect, useRef, useState } from 'react';
import { sharedSandboxPerks } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { getAliasGroupsHead, removeGroupMember } from '../../services/aliasGroups';
import { useAuthStore } from '../../stores/auth';
import { applyGroupRemoval, useDataStore } from '../../stores/data';
import { Popover } from '../../ui/Popover';
import styles from './InactiveMoveControl.module.scss';

/**
 * Maintainers take one member out of its accepted group (never the main entry), with an in-place confirm.
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
  const [head, setHead] = useState<string | null>(null);
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
    setHead(null);
    setError(null);
    if (!open || !allowed) return;
    const abort = new AbortController();
    void getAliasGroupsHead(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setHead(value);
      },
      (reason: unknown) => {
        if (!abort.signal.aborted)
          setError(
            `${reason instanceof Error ? reason.message : 'Cannot load alias groups'}. Close and reopen to reload, then try again.`,
          );
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
      <span title={`Another item also uses perk effect ${shared.join(', ')}`}>
        Can't remove: shared perk effect
      </span>
    );
  const save = async () => {
    if (!head || savingRef.current) return;
    const identity = useAuthStore.getState();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await removeGroupMember(head, canonical, hash);
      const current = useAuthStore.getState();
      if (current.user !== identity.user || current.token !== identity.token) return;
      setOpen(false);
      try {
        applyGroupRemoval(result, hash);
      } catch {
        // Saved on the server: a local failure only needs the data again.
        void useDataStore.getState().load({ background: true });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Cannot remove from group';
      setError(
        message.replace(/[.!?]?$/, '.') +
          (reason instanceof Error && 'refused' in reason && reason.refused
            ? ''
            : ' Close and reopen to reload, then try again.'),
      );
      // A conflict requires closing and reopening for a fresh head and confirmation.
      setHead(null);
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
            Its perk effects stay with it. Automatic grouping will not add it back.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {!head && !error && <p role="status">Checking the saved groups…</p>}
          <div className={styles.actions}>
            <button type="button" data-autofocus onClick={() => close()}>
              Cancel
            </button>
            <button type="button" disabled={!head || saving} onClick={() => void save()}>
              {saving ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
