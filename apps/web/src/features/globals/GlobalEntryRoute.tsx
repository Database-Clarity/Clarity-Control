import { useEffect } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { languages, type Lang } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import {
  globalsSession,
  loadGlobalIdentities,
  rememberGlobalIdentities,
} from '../../stores/globalEntries';
import { globalIdOf, useGlobalIdentities } from '../../stores/globalIdentities';
import type { GlobalActor } from '../../services/globals';
import { GlobalEntryWorkspace } from './GlobalEntryWorkspace';
import styles from './GlobalEntryWorkspace.module.scss';
import { IdentityStatus } from '../auth/AuthStatus';

function EditingRoleRequired() {
  return (
    <section className={styles.workspace}>
      <p>Global entries need an editing role.</p>
      <IdentityStatus />
    </section>
  );
}

function useActor(): GlobalActor {
  const user = useAuthStore((state) => state.user);
  return user?.role ? { role: user.role, languages: user.languages ?? [] } : null;
}

/** `/globals` and `/globals/:id`: the per-entry editor, addressed by stable ID. */
export function GlobalEntryRoute() {
  const { id } = useParams<'id'>();
  const actor = useActor();
  const authLoading = useAuthStore((state) => state.loading);
  // Re-read per session token: a sign-out or account switch never reuses another cache.
  useAuthStore((state) => state.token);
  if (authLoading)
    return (
      <section className={styles.workspace} aria-busy>
        <p>Loading globals…</p>
      </section>
    );
  if (!actor) return <EditingRoleRequired />;
  const session = globalsSession();
  return (
    <GlobalEntryWorkspace
      service={session.service}
      history={session.transport}
      actor={actor}
      entryId={id ?? ''}
      onSnapshot={(snapshot) => rememberGlobalIdentities(snapshot.entries)}
    />
  );
}

/** Keeps only a valid `lang` (and the workspace's own view parameters never leak in). */
function entrySearch(search: string): string {
  const lang = new URLSearchParams(search).get('lang');
  return languages.includes(lang as Lang) ? `?lang=${lang}` : '';
}

/**
 * Resolves a name to its stable ID once the catalogue loads, then replaces the route, so Back
 * never lands on the name form again. Used by `/globals/:kind/:name` and the `/t/2`–`/t/3`
 * hand-off; no aggregate editor ever mounts for variables or titles.
 */
function GlobalResolver({ kind, name }: { kind: 'variables' | 'titles'; name: string | null }) {
  const { search } = useLocation();
  const actor = useActor();
  const authLoading = useAuthStore((state) => state.loading);
  const role = actor?.role;
  const { identities, status, error } = useGlobalIdentities();
  useEffect(() => {
    // Loads once; a failure waits for the person's Retry, never an automatic repeat.
    if (!authLoading && role && useGlobalIdentities.getState().status === 'idle')
      void loadGlobalIdentities();
  }, [authLoading, role]);
  if (!authLoading && !actor) return <EditingRoleRequired />;
  if (status === 'ready' || status === 'loading') {
    const id =
      name === null
        ? Object.entries(identities).find(([, identity]) => identity.kind === kind)?.[0]
        : globalIdOf(identities, kind, name);
    if (id) return <Navigate to={`/globals/${id}${entrySearch(search)}`} replace />;
    if (status === 'ready')
      return (
        <section className={styles.workspace}>
          <p>
            {name === null ? `No ${kind} yet.` : `No live global named ${name}.`}{' '}
            <Link to="/globals">Open globals</Link>
          </p>
        </section>
      );
  }
  if (status === 'failed')
    return (
      <section className={styles.workspace}>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void loadGlobalIdentities(true)}>
          Retry
        </button>
      </section>
    );
  return (
    <section className={styles.workspace} aria-busy>
      <p>Loading globals…</p>
    </section>
  );
}

export function GlobalNameRoute() {
  const { kind, name } = useParams<'kind' | 'name'>();
  if (kind !== 'variables' && kind !== 'titles') return <Navigate to="/globals" replace />;
  return <GlobalResolver kind={kind} name={name ?? null} />;
}

/** `/t/2` and `/t/3` with globals on: the aggregates are projections, edited per entry. */
export function GlobalAggregateHandOff() {
  const { hash } = useParams<'hash'>();
  const { search } = useLocation();
  return (
    <GlobalResolver
      kind={hash === '2' ? 'variables' : 'titles'}
      name={new URLSearchParams(search).get('global')}
    />
  );
}
