import { useState } from 'react';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { UpcomingEnglish } from '../translations/upcomingEnglish';
import styles from './BatchDestination.module.scss';
import {
  isMarkupOnly,
  languages,
  merge3,
  stableStringify,
  type Lang,
  type Tooltip,
  type MarkupGlobals,
} from '@clarity/core';
import {
  batchDraftKey,
  discardBatchDraft,
  draftsOfBatch,
  updateBatchDrafts,
  useBatchDraftStore,
} from '../../services/scheduled/batchDrafts';
import type { Drafts } from '../../services/draftStorage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { sessionToken } from '../../services/session';
import { prepareChanges } from '../../services/save/pipeline';
import { saveReviewToBatch } from '../review/batches/saveDestination';
import type { BatchEditing } from './batchDestination';
import { upcomingStore } from './UpcomingSwitch.store';
import { adoptBatchMembers, upcomingState } from './UpcomingSwitch.load';

export const subscribe = useBatchDraftStore.subscribe;
export const snapshot = useBatchDraftStore.getState;
export function drafts(source: Drafts, batchId: string): Drafts {
  const staged = draftsOfBatch(source, batchId);
  const data = useDataStore.getState().data;
  const load = upcomingStore().getState().loads[batchId];
  if (!data || load?.state !== 'ready') return Object.fromEntries(staged);
  // Display the activation result; stored drafts keep their proposal merge bases for saving.
  return upcomingState(
    [...staged].flatMap(([hash, draft]) => {
      const member = load.upcoming.members[hash];
      if (!member) return [];
      const proposed = { ...member.proposed, text: { ...member.proposed.text } };
      for (const lang of languages) {
        if (
          stableStringify(draft.base.text[lang] ?? null) ===
          stableStringify(draft.next.text[lang] ?? null)
        )
          continue;
        if (draft.next.text[lang]) proposed.text[lang] = draft.next.text[lang];
        else delete proposed.text[lang];
      }
      return [{ ...member, proposed }];
    }),
    data,
  ).overlay;
}
/** Whether the batch moved under the local draft, so saving it would report a conflict. */
export function conflicted(source: Drafts, batchId: string, hash: number): boolean {
  const load = upcomingStore().getState().loads[batchId];
  const draft = source[batchDraftKey(batchId, hash)];
  const proposed = load?.state === 'ready' && load.upcoming.members[hash]?.proposed;
  return !!draft && !!proposed && !merge3(draft.base, proposed, draft.next).ok;
}
export const discard = discardBatchDraft;
/** Keep the proposal as the merge base, but attribute translation text to the future English. */
export function edit(
  batchId: string,
  base: Tooltip,
  future: Tooltip,
  lang: Lang,
  text: string,
  author: string,
) {
  const auth = useAuthStore.getState();
  const local = useBatchDraftStore.getState();
  const state = upcomingStore().getState();
  const load = state.loads[batchId];
  const batch = state.memberOf[base.hash];
  if (
    !auth.user ||
    auth.loading ||
    local.owner !== String(auth.user.id) ||
    local.external ||
    state.listFailed ||
    !batch ||
    batch.id !== batchId ||
    batch.status === 'publishing' ||
    // A scheduled batch, or one whose schedule is preparing or failed, takes translations only.
    ((batch.status === 'scheduled' || batch.notBefore !== null) && lang === 'en') ||
    load?.state !== 'ready' ||
    load.revision !== batch.revision ||
    stableStringify(load.upcoming.members[base.hash]?.proposed) !== stableStringify(base)
  )
    return;
  if (auth.user.role === 'translator' && (lang === 'en' || !auth.user.languages?.includes(lang)))
    return;
  if (!['maintainer', 'editor', 'translator'].includes(auth.user.role ?? '')) return;
  updateBatchDrafts(batchId, [
    {
      base,
      update: (current) => {
        const next = { ...current, text: { ...current.text } };
        if (text === (base.text[lang]?.text ?? '') || text === (future.text[lang]?.text ?? '')) {
          if (base.text[lang]) next.text[lang] = base.text[lang];
          else delete next.text[lang];
        } else
          next.text[lang] = {
            text,
            updatedAt: new Date().toISOString(),
            updatedBy: author,
            ...(lang !== 'en' && future.text.en
              ? { sourceUpdatedAt: future.text.en.updatedAt }
              : {}),
          };
        return next;
      },
    },
  ]);
}

export async function saveBatchDrafts(batchId: string): Promise<string> {
  const auth = useAuthStore.getState();
  const user = auth.user;
  const data = useDataStore.getState().data;
  const state = upcomingStore().getState();
  const load = state.loads[batchId];
  const local = useBatchDraftStore.getState();
  if (
    !user ||
    !['maintainer', 'editor', 'translator'].includes(user.role ?? '') ||
    auth.loading ||
    !data ||
    state.listFailed ||
    load?.state !== 'ready' ||
    !local.hydrated ||
    local.owner !== String(user.id) ||
    local.external ||
    local.error
  )
    throw new Error('Reload the batch and sign in before saving. Drafts were kept.');
  const batch = Object.values(state.memberOf).find((entry) => entry.id === batchId);
  if (
    !batch ||
    batch.revision !== load.revision ||
    (batch.status !== 'draft' && batch.status !== 'scheduled')
  )
    throw new Error(
      'The batch takes no saves now (changed, publishing, or preparing a request). Drafts were kept.',
    );
  const sameAccount = () => {
    const current = useAuthStore.getState();
    return (
      !current.loading &&
      current.user === user &&
      current.token === auth.token &&
      sessionToken() === auth.token
    );
  };
  const tooltips = { ...data.bundle.tooltips };
  for (const [hash, draft] of Object.entries(load.upcoming.overlay)) tooltips[hash] = draft.next;
  const futureData = { ...data, bundle: { ...data.bundle, tooltips } };
  return saveReviewToBatch(
    { kind: 'batch', id: batchId },
    [],
    '',
    {},
    sameAccount,
    async (changes) => {
      const prepared = await prepareChanges(changes, user, futureData);
      return prepared.map((change, index) => {
        const authored = changes[index]!;
        const text = { ...change.next.text };
        for (const lang of languages) {
          const entry = authored.next.text[lang];
          if (
            lang === 'en' ||
            !entry ||
            entry.text === authored.base?.text[lang]?.text ||
            isMarkupOnly(authored.base?.text[lang]?.text, entry.text)
          )
            continue;
          // The revision the author actually read, even if the batch moved meanwhile.
          if (entry.sourceUpdatedAt && text[lang])
            text[lang] = { ...text[lang]!, sourceUpdatedAt: entry.sourceUpdatedAt };
        }
        return { ...change, next: { ...change.next, text } };
      });
    },
    (members) => adoptBatchMembers(batchId, members),
  );
}

export function BatchSave({
  editing,
  onNotice,
}: {
  editing: BatchEditing;
  onNotice(notice: string): void;
}) {
  const [pending, setPending] = useState(false);
  const count = Object.keys(editing.drafts).length;
  return (
    <span className={styles.save} role="group" aria-label="Batch draft save">
      <button
        type="button"
        title={`Save drafts to ${editing.destination.batchName}`}
        aria-label={`Save drafts to ${editing.destination.batchName}`}
        disabled={pending || !!editing.reason || !count}
        onClick={async () => {
          setPending(true);
          onNotice('');
          try {
            onNotice(await saveBatchDrafts(editing.destination.batchId));
          } catch (error) {
            onNotice(error instanceof Error ? error.message : String(error));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Saving…' : 'Save batch'}
      </button>
    </span>
  );
}

/** Reuse the Upcoming view's English rules in the editor pane shell. */
export function BatchEnglish(props: {
  hash: number;
  current: string | undefined;
  upcoming: string;
  globals: MarkupGlobals;
  reason?: string | null;
  retry?: () => void;
}) {
  return (
    <UpcomingEnglish
      {...props}
      editor
      notice={
        props.reason ? (
          <p className={styles.notice} role="status">
            {props.reason}{' '}
            {props.retry && (
              <button type="button" onClick={props.retry}>
                Retry batch
              </button>
            )}
          </p>
        ) : undefined
      }
    />
  );
}

export function BatchSourceNotice({
  reason,
  retry,
}: {
  reason: string | null;
  retry?: () => void;
}) {
  return (
    <RightPane label="Upcoming English" header={<RightPaneHeader title="Upcoming English" />}>
      <p className={styles.notice} role="status">
        {reason ?? 'This tooltip is not in the destination batch.'}
      </p>
      {retry && (
        <button type="button" className={styles.retry} onClick={retry}>
          Retry batch
        </button>
      )}
    </RightPane>
  );
}
