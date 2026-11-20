import { useEffect, useState, type ReactNode } from 'react';
import type { MarkupGlobals } from '@clarity/core';
import { Popover } from '../../ui/Popover';
import { TooltipPreview } from '../preview';
import { SourceRef } from '../compendium/SourceRef';
import { sourceHref } from '../compendium/sourceLocation';
import { useCompendiumStore } from '../compendium/store';
import {
  editorDraft,
  editorDraftIndex,
  knownDraftIndex,
  sourceChanged,
  type EditorDraft,
} from '../../services/editorDrafts';
import pageStyles from './TooltipPage.module.scss';
import styles from './DraftLoader.module.scss';
import { translationView } from '../terms/insert';
import { startFromEnglish } from '../editor/numbers/NumberTools';

/** The empty translation uses the same header slot as an empty English draft. */
export function StartEnglishLoader({ hash }: { hash: number }) {
  return (
    <button
      type="button"
      className={pageStyles.ghost}
      title="Copy English with its numbers as tokens (Ctrl+K, then S)"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const view = translationView(hash);
        if (view) startFromEnglish(view);
      }}
    >
      Start from English
    </button>
  );
}

/** After the workspace is ready, the session's one index request waits this long. */
const indexDelay = 1500;
/** A tooltip must stay open this long before its draft is requested (stepping past asks nothing). */
const draftDelay = 250;

/**
 * What the header shows for this tooltip's agent-written draft while `enabled` (an empty English
 * tooltip an editor or maintainer can edit): "Load draft…" when the session's index lists it, a
 * hidden slot of the same size when the index was not known yet as the tooltip opened (so its
 * answer moves nothing), else nothing. The slot is decided before the header paints, never after.
 */
export type DraftOffer =
  { slot: 'none' } | { slot: 'reserve' } | { slot: 'draft'; draft: EditorDraft | null | undefined };

/**
 * Asks for the session's index once, then, only while `settled` (not stepping), for the draft of a
 * tooltip that stays open. `draft` is undefined until it arrives and null when it failed.
 */
export function useEditorDraft(hash: number, enabled: boolean, settled = true): DraftOffer {
  const [found, setFound] = useState<{ hash: number; draft: EditorDraft | null }>();
  // Whether the index was in memory when this tooltip opened (a render-time reset per tooltip).
  const [opened, setOpened] = useState({ hash, knew: knownDraftIndex() !== undefined });
  let knew = opened.knew;
  if (opened.hash !== hash) {
    knew = knownDraftIndex() !== undefined;
    setOpened({ hash, knew });
  }
  const fetching = enabled && settled;
  useEffect(() => {
    if (!fetching) return;
    let live = true;
    const index = knownDraftIndex();
    if (index && !index.has(hash)) return;
    const timer = setTimeout(
      () =>
        void editorDraftIndex()
          .then((hashes) => (live && hashes.has(hash) ? editorDraft(hash) : null))
          .then((draft) => {
            if (live) setFound({ hash, draft });
          }),
      index ? draftDelay : indexDelay,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hash, fetching]);
  if (!enabled) return { slot: 'none' };
  if (knownDraftIndex()?.has(hash))
    return { slot: 'draft', draft: found?.hash === hash ? found.draft : undefined };
  return knew ? { slot: 'none' } : { slot: 'reserve' };
}

/** Renders `children` with this tooltip's draft offer; adds no element. */
export function WithEditorDraft({
  hash,
  enabled,
  settled,
  children,
}: {
  hash: number;
  /** An empty English tooltip that an editor or maintainer can edit. */
  enabled: boolean;
  /** Not stepping: only then is the draft itself requested. */
  settled: boolean;
  children(offer: DraftOffer): ReactNode;
}) {
  return children(useEditorDraft(hash, enabled, settled));
}

/** The hidden stand-in for "Load draft…": the same button, so it takes exactly its room. */
export function DraftSlot() {
  return (
    <button
      type="button"
      className={pageStyles.ghost}
      style={{ visibility: 'hidden' }}
      aria-hidden="true"
      tabIndex={-1}
    >
      Load draft…
    </button>
  );
}

/**
 * "Load draft…": a draft written from this tooltip's Compendium match, previewed in a popover with
 * its source; Load puts it in the editor as an ordinary unsaved edit (undo, Discard, and Save work
 * as for typed text; nothing is saved here).
 */
export function DraftLoader({
  draft,
  name,
  categoryLabel,
  globals,
  onLoad,
}: {
  /** Undefined while it loads. */
  draft: EditorDraft | undefined;
  name: string;
  categoryLabel?: string;
  globals: MarkupGlobals;
  onLoad(text: string): void;
}) {
  return (
    <Popover
      label="Draft for this tooltip"
      className={pageStyles.ghost}
      trigger="Load draft…"
      triggerTitle="Preview the draft written from this tooltip's Compendium entry, then load it into the editor"
    >
      {(close) =>
        !draft ? (
          <p className={styles.note} role="status">
            Loading the draft…
          </p>
        ) : (
          <DraftSummary
            draft={draft}
            name={name}
            categoryLabel={categoryLabel}
            globals={globals}
            onLoad={() => {
              close(false);
              onLoad(draft.english);
            }}
          />
        )
      }
    </Popover>
  );
}

function DraftSummary({
  draft,
  name,
  categoryLabel,
  globals,
  onLoad,
}: {
  draft: EditorDraft;
  name: string;
  categoryLabel?: string;
  globals: MarkupGlobals;
  onLoad(): void;
}) {
  const compendium = useCompendiumStore((state) => state.data);
  // The change check needs the current sheet; the Compendium tab usually loaded it already.
  useEffect(() => {
    if (!compendium) void useCompendiumStore.getState().load();
  }, [compendium]);
  const changed = sourceChanged(draft, compendium);
  const { tab, gid, range } = draft.source;
  return (
    <div className={styles.summary}>
      <TooltipPreview
        text={draft.english}
        lang="en"
        name={name}
        categoryLabel={categoryLabel}
        globals={globals}
        tooltipHash={draft.hash}
      />
      <div className={styles.side}>
        <div className={styles.source}>
          <span className={styles.from}>From</span>
          <SourceRef
            location={{ tab, gid, range, label: `${tab} · ${range}`, href: sourceHref(gid, range) }}
          />
        </div>
        {changed && (
          <p className={styles.changed} role="status">
            Source changed since this draft
          </p>
        )}
        <button type="button" className={styles.load} onClick={onLoad}>
          Load draft
        </button>
        <p className={styles.note}>Loads as an unsaved edit: undo or Discard removes it.</p>
      </div>
    </div>
  );
}
