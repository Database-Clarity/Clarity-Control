import { useCallback, useEffect, useState } from 'react';
import {
  teamSnippetSeeds,
  type CustomSnippet,
} from '../../../../../packages/core/src/customSnippets';
import {
  copyPersonalSnippetToTeam,
  getTeamSnippets,
  saveTeamSnippet,
  SnippetConflictError,
} from '../../services/snippets';
import { invalidateSnippetCatalogue } from '../editor/suggest/custom';
import { usePersonalSnippets } from './MySnippets';
import { saveError } from './SnippetFields';
import { conflictMessage, SnippetManager } from './SnippetManager';
import styles from './Snippets.module.scss';

const teamId = () => `team:${crypto.randomUUID()}`;

/**
 * Management → Team snippets (maintainers): the shared set everyone signed in sees, marked Team.
 * Every write is a compare-and-set on one entry; a conflict says so and offers Reload.
 */
export function TeamSnippets() {
  const [team, setTeam] = useState<CustomSnippet[] | null>(null);
  const [status, setStatus] = useState({ loading: false, error: null as string | null });
  const [extra, setExtra] = useState<{ text: string; conflict: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const mine = usePersonalSnippets(true);
  const reload = useCallback(() => {
    setStatus({ loading: true, error: null });
    getTeamSnippets()
      .then((found) => {
        setTeam(found.team.snippets);
        setStatus({ loading: false, error: null });
      })
      .catch((error: unknown) =>
        setStatus({ loading: false, error: `Team snippets could not load: ${saveError(error)}` }),
      );
  }, []);
  useEffect(reload, [reload]);

  const changed = (next: CustomSnippet[]) => {
    setTeam(next);
    invalidateSnippetCatalogue();
  };
  async function save(current: CustomSnippet | null, next: CustomSnippet | null) {
    const id = (next ?? current)!.id;
    const saved = await saveTeamSnippet({ id, base: current, next });
    changed(saved.team.snippets);
  }
  async function act(action: () => Promise<void>, done: string) {
    setBusy(true);
    setExtra(null);
    try {
      await action();
      setExtra({ text: done, conflict: false });
    } catch (error) {
      setExtra(
        error instanceof SnippetConflictError
          ? { text: conflictMessage, conflict: true }
          : { text: saveError(error), conflict: false },
      );
    } finally {
      setBusy(false);
    }
  }

  const labels = new Set((team ?? []).map((snippet) => snippet.label.toLowerCase()));
  const ids = new Set((team ?? []).map((snippet) => snippet.id));
  // The starter set (Refills, Enemy Rank): offered while any of it is missing.
  const missingSeeds = teamSnippetSeeds.filter(
    (seed) => !ids.has(seed.id) && !labels.has(seed.label.toLowerCase()),
  );
  const copyable = (mine.entries ?? []).filter(
    (entry) => !labels.has(entry.snippet.label.toLowerCase()),
  );
  const chosen = copyable.find((entry) => entry.snippet.id === source) ?? copyable[0];
  const full = (team?.length ?? 0) >= 100;

  const actions = team && (
    <>
      {missingSeeds.length > 0 && (
        <button
          type="button"
          disabled={busy || full}
          onClick={() =>
            void act(async () => {
              let latest = team;
              for (const seed of missingSeeds) {
                const saved = await saveTeamSnippet({ id: seed.id, base: null, next: seed });
                latest = saved.team.snippets;
                changed(latest);
              }
            }, 'Added the starter snippets.')
          }
        >
          Add the starter snippets
        </button>
      )}
      {copyable.length > 0 && chosen && (
        <span className={styles.toolbar}>
          <select
            aria-label="One of my snippets"
            value={chosen.snippet.id}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
          >
            {copyable.map((entry) => (
              <option key={entry.snippet.id} value={entry.snippet.id}>
                {entry.snippet.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || full}
            onClick={() =>
              void act(async () => {
                const saved = await copyPersonalSnippetToTeam(
                  chosen.snippet.id,
                  chosen.revision,
                  teamId(),
                );
                changed(saved.team.snippets);
              }, `Copied “${chosen.snippet.label}” to the team.`)
            }
          >
            Copy from my snippets
          </button>
        </span>
      )}
    </>
  );

  return (
    <div className={styles.manager}>
      <SnippetManager
        name="Team snippets"
        snippets={team}
        limit={100}
        status={status}
        onReload={reload}
        save={save}
        newId={teamId}
        actions={actions}
      />
      {extra && (
        <p className={extra.conflict ? styles.conflict : styles.notice} role="status">
          {extra.text}{' '}
          {extra.conflict && (
            <button
              type="button"
              onClick={() => {
                setExtra(null);
                reload();
                mine.reload();
              }}
            >
              Reload
            </button>
          )}
        </p>
      )}
    </div>
  );
}
