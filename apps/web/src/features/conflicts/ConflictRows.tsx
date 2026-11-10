import { languages, type CompendiumLink, type Lang, type Tooltip } from '@clarity/core';
import { linkLocation } from '../compendium/sourceLocation';
import { useCompendiumStore } from '../compendium/store';
import { languageLabel } from '../../languageLabels';
import {
  useConflictStore,
  usePausedForOtherTab,
  type ConflictSession,
} from '../../stores/conflicts';
import { useDraftStore } from '../../stores/drafts';
import { PanelRow } from '../../ui/PanelRow';
import { fieldValue } from './reducer';
import { markersIn } from './summary';

const fieldNames: Record<string, string> = {
  compendium: 'Compendium link',
  custom: 'Custom name',
  bungieSnapshot: 'Bungie text',
  archive: 'Archive note',
};

const short = (value: unknown) => {
  const text = value === undefined ? 'none' : JSON.stringify(value);
  return text.length > 36 ? `${text.slice(0, 35)}…` : text;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describe(session: ConflictSession, field: string) {
  if (field === '$exists') {
    return session.head === null
      ? {
          label: 'Deleted on the server',
          summary: 'Someone deleted this tooltip while you edited it.',
          mine: 'Keep mine and save it again',
          theirs: 'Accept the deletion and discard my draft',
        }
      : {
          label: 'Created on the server',
          summary: 'Someone created this tooltip while you did.',
          mine: 'Keep mine and save over theirs',
          theirs: 'Use theirs and discard my draft',
        };
  }
  const read = (tooltip: Tooltip | null) => (tooltip ? fieldValue(tooltip, field) : undefined);
  // A Compendium link reads as its sheet location (tab · section · range), never as raw JSON with a gid.
  const show =
    field === 'compendium'
      ? (value: unknown) =>
          value
            ? linkLocation(value as CompendiumLink, useCompendiumStore.getState().data).label
            : 'none'
      : short;
  return {
    label: fieldNames[field] ?? field,
    summary: `Mine ${show(read(session.mine))} · theirs ${show(read(session.head))}`,
    mine: 'Keep my value',
    theirs: 'Use their value',
  };
}

/**
 * What a conflict leaves besides the text blocks: a row per non-text field that still needs a
 * choice (mine or theirs), and a pointer to other languages whose text carries marker blocks.
 * Pinned under the preview with the other rows.
 */
export function ConflictRows({
  hash,
  lang,
  onLanguage,
}: {
  hash: number;
  lang: Lang;
  onLanguage(lang: Lang): void;
}) {
  const session = useConflictStore((state) => state.sessions[hash]);
  const choose = useConflictStore((state) => state.choose);
  const paused = usePausedForOtherTab();
  const draft = useDraftStore((state) => state.drafts[hash]);
  const markers = draft ? markersIn(draft.next) : {};
  const others = languages.filter((other) => other !== lang && markers[other]);
  const here = markers[lang] ?? 0;
  const open = session ? Object.entries(session.rows).filter(([, choice]) => choice === null) : [];
  if (!here && !others.length && !open.length) return null;
  return (
    <section aria-label="Conflicts" data-conflict-rows>
      {here > 0 && <PanelRow label="Conflicts" summary={`${plural(here, 'conflict')} · F8 next`} />}
      {others.map((other) => (
        <PanelRow
          key={other}
          label={languageLabel(other)}
          summary={`${plural(markers[other]!, 'conflict')} in the text`}
          actions={
            <button type="button" onClick={() => onLanguage(other)}>
              Open
            </button>
          }
        />
      ))}
      {session &&
        open.map(([field]) => {
          const text = describe(session, field);
          return (
            <PanelRow
              key={field}
              label={<span title={text.summary}>{text.label}</span>}
              // The explanation is the label's tooltip; a one-line summary only where it can fit.
              summary={field === '$exists' ? undefined : text.summary}
              actions={
                <>
                  <button
                    type="button"
                    aria-label={`${text.mine} (${text.label})`}
                    title={text.mine}
                    disabled={paused}
                    onClick={() => choose(hash, field, 'mine')}
                  >
                    Mine
                  </button>
                  <button
                    type="button"
                    aria-label={`${text.theirs} (${text.label})`}
                    title={text.theirs}
                    disabled={paused}
                    onClick={() => choose(hash, field, 'theirs')}
                  >
                    Theirs
                  </button>
                </>
              }
            />
          );
        })}
    </section>
  );
}
