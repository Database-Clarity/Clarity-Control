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

/** After the workspace is ready, the session's one index request waits this long. */
const indexDelay = 1500;
/** A tooltip must stay open this long before its draft is requested (stepping past asks nothing). */
const draftDelay = 250;

/**
 * Whether this tooltip has an agent-written draft, read only while `enabled` (an empty English
 * tooltip an editor or maintainer can edit) and not stepping. Asks for the session's index once,
 * then only for the draft of a tooltip that stays open.
 */
export function useEditorDraft(hash: number, enabled: boolean) {
  const [found, setFound] = useState<{ hash: number; draft: EditorDraft | null }>();
  useEffect(() => {
    if (!enabled) return;
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
  }, [hash, enabled]);
  return enabled && found?.hash === hash ? found.draft : null;
}

/** Renders `children` with this tooltip's draft (null: none, or not `enabled`); adds no element. */
export function WithEditorDraft({
  hash,
  enabled,
  children,
}: {
  hash: number;
  /** An empty English tooltip that an editor or maintainer can edit, and not stepping. */
  enabled: boolean;
  children(draft: EditorDraft | null): ReactNode;
}) {
  return children(useEditorDraft(hash, enabled));
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
  draft: EditorDraft;
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
      {(close) => (
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
      )}
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
