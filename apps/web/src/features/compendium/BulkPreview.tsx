import type { CompendiumData, CompendiumLink, CompendiumMatch } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { ReviewEntry } from './reviewCategories';
import type { ReviewProposal } from './rapidReview';
import { ProposalContext } from './ProposalContext';
import styles from './MatchReview.module.scss';

export interface BulkProposal {
  entry: ReviewEntry;
  link: CompendiumLink;
  match?: CompendiumMatch;
}
export interface BulkPreviewState {
  editor: EditorData;
  source: CompendiumData;
  proposals: BulkProposal[];
}
export function createBulkPreview(
  editor: EditorData,
  source: CompendiumData,
  entries: ReviewEntry[],
  proposals: Map<number, ReviewProposal>,
): BulkPreviewState {
  return {
    editor,
    source,
    proposals: entries.flatMap((entry) => {
      const proposal = proposals.get(entry.hash);
      return entry.status === 'open' && proposal?.link
        ? [{ entry, link: proposal.link, match: proposal.match }]
        : [];
    }),
  };
}
export function bulkPreviewCurrent(
  preview: BulkPreviewState,
  editor: EditorData,
  source: CompendiumData,
  entries: ReviewEntry[],
  proposals: Map<number, ReviewProposal>,
  drafts: Drafts,
) {
  if (preview.editor !== editor || preview.source !== source) return false;
  const current = new Map(entries.map((entry) => [entry.hash, entry]));
  return preview.proposals.every(({ entry, link }) => {
    const next = current.get(entry.hash);
    return (
      next?.status === 'open' &&
      next.evidence === entry.evidence &&
      next.next === entry.next &&
      (drafts[entry.hash]?.next ?? editor.bundle.tooltips[entry.hash] ?? entry.base) ===
        entry.next &&
      JSON.stringify(proposals.get(entry.hash)?.link) === JSON.stringify(link)
    );
  });
}
export function BulkPreview({
  preview,
  page,
  canEdit,
  current,
  onPage,
  onCancel,
  onAccept,
}: {
  preview: BulkPreviewState;
  page: number;
  canEdit: boolean;
  current: boolean;
  onPage: (page: number) => void;
  onCancel: () => void;
  onAccept: (proposals: BulkProposal[]) => void;
}) {
  const visible = preview.proposals.slice(page * 10, page * 10 + 10);
  const disabled = !canEdit || !current || !visible.length;
  return (
    <section
      className={styles.overlay}
      role="dialog"
      aria-modal="false"
      aria-label="Bulk accept preview"
    >
      <header>
        <div>
          <h2>Review {preview.proposals.length} proposals</h2>
          <p>Filters at preview opening · validated resolver matches only · local drafts</p>
        </div>
        <button autoFocus onClick={onCancel}>
          Cancel
        </button>
      </header>
      {!current && (
        <p role="alert">
          Preview evidence or drafts changed. Cancel and open a new preview before accepting.
        </p>
      )}
      <p>
        Preview page {page + 1} / {Math.max(1, Math.ceil(preview.proposals.length / 10))} · 10
        proposals per page. Accept applies only to this page and closes the preview.
      </p>
      <button disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous proposals
      </button>{' '}
      <button
        disabled={(page + 1) * 10 >= preview.proposals.length}
        onClick={() => onPage(page + 1)}
      >
        Next proposals
      </button>
      <div className={styles.bulkList}>
        {visible.map(({ entry, match }) => (
          <section key={entry.hash}>
            <h3>
              {entry.name} · {entry.hash}
            </h3>
            <div className={styles.bulkCompare}>
              <pre>{entry.next.text.en?.text || 'No English text yet.'}</pre>
              <div>
                <ProposalContext match={match} source={preview.source} />
              </div>
            </div>
          </section>
        ))}
      </div>
      <button
        className={styles.primary}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onAccept(visible);
        }}
      >
        Accept {visible.length} proposals on this page as drafts
      </button>
    </section>
  );
}
