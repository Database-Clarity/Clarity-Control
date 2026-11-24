import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { languages, parseMarkup, type Lang, type MarkupLine, type Tooltip } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { getHistory, type HistoryCommit } from '../../services/history';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { replaceDraft } from '../../services/save/drafts';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { Dialog } from '../../ui/Dialog';
import { diffWords } from '../../ui/diff';
import { SkeletonLine, SkeletonRegion } from '../../ui/Skeleton';
import { CommitAuthor } from '../history/CommitAuthor';
import { Body, diffGlobals } from '../history/RenderedWordDiff';
import {
  presentDiff,
  renderedDiff,
  variantGlobals,
  type DiffLine,
  type DiffSpan,
} from '../history/renderedDiff';
import { revertDraft } from '../history/revert';
import { CompendiumChanges, FieldChanges } from '../history/TooltipDiff';
import { useRenderedDiff } from '../history/useRenderedDiff';
import { itemFor, listName } from '../navigation/catalog';
import { globalUsers, unitName, type GlobalPart } from './globalRows';
import { publishedGlobals, type PendingGlobal } from './globalsPending';
import { reviewGlobals, textLanguages, type Classification } from './kinds';
import type { PendingTooltip } from './model';
import { exportedText, type Published } from './published';
import { useDelayed } from './useDelayed';
import styles from './Review.module.scss';

const count = new Intl.NumberFormat('en');
const list = (words: string[]) =>
  words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;

/** The text a tooltip shows when its whole English text is an import of another tooltip. */
function importedName(tooltip: Tooltip, data: EditorData | null): string | undefined {
  const match = /^import main from (\d+)\s*$/.exec(tooltip.text.en?.text ?? '');
  if (!match || !data) return undefined;
  const hash = Number(match[1]);
  return data.items[hash]?.name ?? data.bundle.tooltips[hash]?.custom?.name;
}

/** One sentence that answers "what will players see differently?" (spec §6). */
function Sentence({
  entry,
  published,
  classification,
  onRetry,
}: {
  entry: PendingTooltip;
  published: Published | undefined;
  classification: Classification | undefined;
  onRetry(): void;
}): ReactNode {
  const data = useDataStore((state) => state.data);
  // Published text is only asked for with an API and a signed-in role.
  const compares = useAuthStore((state) => Boolean(apiUrl && state.user?.role));
  const waiting = !classification && (!published || published.status === 'loading');
  const late = useDelayed(
    compares && (waiting || (published?.status === 'ready' && !classification)),
  );
  const pending = entry.part?.pending;
  const noun = entry.part ? entry.part.kind.slice(0, -1) : 'tooltip';
  if (entry.unpublishable)
    return (
      <p className={styles.sentence} data-tone="warn">
        <b>Can&apos;t be published yet.</b> {entry.unpublishable}
      </p>
    );
  switch (classification?.kind) {
    case 'Text changed': {
      const { scope, languages = [] } = classification;
      const where =
        scope === 'both'
          ? ' on the base and the enhanced perk'
          : scope === 'enhanced'
            ? ' on the enhanced perk only'
            : scope === 'base'
              ? ' on the base perk only'
              : '';
      const langs =
        languages.length === 1 && languages[0] === 'en'
          ? ''
          : ` in ${list(languages.map((lang) => languageLabel(lang)))}`;
      return (
        <p className={styles.sentence}>
          <b>Text changed</b>
          {where}
          {langs}.{classification.numbers && ' The stored number values changed.'}
        </p>
      );
    }
    case 'No visible change':
      return (
        <p className={styles.sentence}>
          <b>No visible change.</b> Players see the same text as now.
          {classification.markupLines
            ? ` Only the markup changed (${count.format(classification.markupLines)} ${classification.markupLines === 1 ? 'line' : 'lines'}).`
            : ''}
        </p>
      );
    case 'Output unchanged':
      return (
        <p className={styles.sentence}>
          <b>Output unchanged.</b>{' '}
          {Object.values(entry.part?.source.before ?? {}).some((text) =>
            /^export hidden /.test(text),
          )
            ? 'The published version hides this export; its text is the same.'
            : 'Only how it is written changed; its text is the same.'}
        </p>
      );
    case 'Definition changed':
      if (pending && !changesText(entry))
        return (
          <p className={styles.sentence}>
            <b>Definition changed.</b> Its text is the same.
          </p>
        );
      return (
        <p className={styles.sentence}>
          <b>Definition changed.</b> It uses other entries or tooltips, so its output may change
          with them.
        </p>
      );
    case 'New': {
      const source = importedName(entry.tooltip, data);
      return (
        <p className={styles.sentence}>
          <b>New {noun}.</b> Not published before.
          {source ? ` It shows the text of ${source}.` : ''}
        </p>
      );
    }
    case 'Links changed':
      return (
        <p className={styles.sentence}>
          <b>No text change.</b> Only links or identity differ:
        </p>
      );
    case 'Renamed':
      return (
        <p className={styles.sentence}>
          <b>Renamed {noun}.</b>{' '}
          {changesText(entry)
            ? 'Its text changed too.'
            : 'Tooltips that use it keep showing its text.'}
        </p>
      );
    case 'Removed':
      return (
        <p className={styles.sentence} data-tone="danger">
          <b>Removes this {noun}.</b>{' '}
          {entry.part
            ? 'Tooltips can no longer use it.'
            : 'It and its alias copies leave every output. The saved text stays editable.'}
        </p>
      );
    case 'Restored':
      return (
        <p className={styles.sentence}>
          <b>Brings this tooltip back.</b> It returns to every output.
        </p>
      );
    case 'Leftover':
      return (
        <p className={styles.sentence}>
          <b>Nothing to publish.</b> The saved text already matches live; this entry is listed only
          because of the alias migration.
        </p>
      );
  }
  if (published?.status === 'error')
    return (
      <p className={styles.sentence} role="alert">
        <b>Couldn&apos;t load the published version.</b>{' '}
        <button type="button" className={styles.textButton} onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  if (published?.status === 'missing')
    return (
      <p className={styles.sentence}>
        <b>No record of the published version.</b> Showing the saved text only.
      </p>
    );
  if (!compares)
    return (
      <p className={styles.sentence}>
        <b>Not compared.</b> Sign in to compare with the published text.
      </p>
    );
  // Not known yet: the sentence's place is kept, and one skeleton line shows after real waiting.
  return (
    <div className={styles.sentence} aria-busy="true">
      {late && (
        <SkeletonRegion>
          <SkeletonLine width={40} />
        </SkeletonRegion>
      )}
    </div>
  );
}

/** A pending global's text differs in some language. */
const changesText = ({ part }: PendingTooltip) =>
  languages.some((lang) => part?.source.before[lang] !== part?.source.after[lang]);

/** Languages a global lists with equal text: a translation became, or stopped being, up to date. */
function sameTextLanguages({ change, languages: cells }: PendingGlobal) {
  return change === 'renamed'
    ? []
    : languages.filter((lang) => cells[lang] && cells[lang].before === cells[lang].after);
}

/** A pending global: the published tooltips that get its new text when it publishes. */
function UpdatedTooltips({ pending }: { pending: PendingGlobal }) {
  const data = useDataStore((state) => state.data);
  const tooltips = useMemo(
    () =>
      pending.affected
        .map((hash) => {
          const item = data ? itemFor(hash, data) : undefined;
          return {
            hash,
            name:
              (item && data && listName(item, data)) ||
              data?.bundle.tooltips[hash]?.custom?.name ||
              `Tooltip ${hash}`,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data, pending],
  );
  const repeated = (index: number) =>
    [tooltips[index - 1], tooltips[index + 1]].some(
      (other) => other?.name === tooltips[index]!.name,
    );
  if (!tooltips.length)
    return <p className={styles.note}>No published tooltip uses it: none is updated.</p>;
  return (
    <details className={styles.updates}>
      <summary>
        Updates {count.format(tooltips.length)} {tooltips.length === 1 ? 'tooltip' : 'tooltips'}
      </summary>
      <ul>
        {tooltips.map(({ hash, name }, index) => (
          <li key={hash}>
            <Link to={`/t/${hash}`}>{name}</Link>
            {repeated(index) && <span className={styles.muted}> · {hash}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A globals entry: which tooltips its change reaches, and that its file publishes as one. */
function GlobalNote({ entry, part }: { entry: PendingTooltip; part: GlobalPart }) {
  const data = useDataStore((state) => state.data);
  const users = useMemo(() => (data ? globalUsers(part, data) : 0), [data, part]);
  return (
    <p className={styles.note}>
      {users
        ? `Used by ${count.format(users)} ${users === 1 ? 'tooltip' : 'tooltips'}.`
        : 'No tooltip uses it directly.'}
      {part.names.length > 1 &&
        ` ${unitName(entry)} are published as one file: including or removing one does the same for ${part.names.length === 2 ? 'both' : `all ${count.format(part.names.length)}`}, and they count as one change.`}
    </p>
  );
}

/** Who saved a pending global last; a removed one is no longer in the catalogue. */
function GlobalSaver({ pending }: { pending: PendingGlobal }) {
  const entries = useDataStore((state) => state.data?.bundle.globals?.entries);
  const last = Object.values(
    entries?.find(({ id, tombstone }) => id === pending.id && !tombstone)?.definitions ?? {},
  ).reduce<{ updatedAt: string; updatedBy: string } | undefined>(
    (latest, value) =>
      !latest || Date.parse(value.updatedAt) > Date.parse(latest.updatedAt) ? value : latest,
    undefined,
  );
  return (
    <p className={styles.savedBy}>
      {last && (
        <>
          Saved by{' '}
          <CommitAuthor
            entry={{
              commit: '',
              author: null,
              message: '',
              login: last.updatedBy,
              date: last.updatedAt,
            }}
          />
        </>
      )}
    </p>
  );
}

/** Rendered text, plain (New, Removed, Restored), 12 lines then "Show all". */
function PlainText({ text, lang, hash }: { text: string; lang: Lang; hash: number }) {
  const data = useDataStore((state) => state.data);
  const [all, setAll] = useState(false);
  const { base, enhanced } = useMemo(() => {
    const saved = diffGlobals(data, {}, lang, hash);
    const globals = hash < 0 ? saved : publishedGlobals(saved, data?.bundle.globalsPending, lang);
    const render = (variant: boolean) => parseMarkup(text, variantGlobals(globals, variant)).lines;
    const base = render(false),
      enhanced = render(true);
    return {
      base,
      enhanced: JSON.stringify(base) === JSON.stringify(enhanced) ? undefined : enhanced,
    };
  }, [data, lang, hash, text]);
  const cut = (lines: MarkupLine[]) => (all ? lines : lines.slice(0, 12));
  const longest = Math.max(base.length, enhanced?.length ?? 0);
  return (
    <>
      <Columns lang={lang} base={cut(base)} enhanced={enhanced && cut(enhanced)} />
      {longest > 12 && !all && (
        <button type="button" className={styles.textButton} onClick={() => setAll(true)}>
          Show all {count.format(longest)} lines
        </button>
      )}
    </>
  );
}

/** One column, or Base and Enhanced side by side (stacked on a phone) when both are given. */
function Columns({
  lang,
  base,
  enhanced,
  only,
}: {
  lang: Lang;
  base?: ReactNode | MarkupLine[];
  enhanced?: ReactNode | MarkupLine[];
  /** Label a single column (only the enhanced perk changes). */
  only?: string;
}) {
  const body = (content: ReactNode | MarkupLine[]) =>
    Array.isArray(content) ? <Body lines={content as MarkupLine[]} lang={lang} /> : content;
  if (base !== undefined && enhanced !== undefined)
    return (
      <div className={styles.columns}>
        <div>
          <h4>Base</h4>
          {body(base)}
        </div>
        <div>
          <h4>Enhanced</h4>
          {body(enhanced)}
        </div>
      </div>
    );
  const single = base ?? enhanced;
  return (
    <div className={styles.single}>
      {only && <h4>{only}</h4>}
      {single !== undefined && body(single)}
    </div>
  );
}

const lineChanged = (line: DiffLine) =>
  !!line.diffKind || !!(line.linesContent as DiffSpan[] | undefined)?.some((span) => span.diffKind);

/** Changed lines with one line of context; the rest folds to "9 unchanged lines". */
function Folded({ lines, lang }: { lines: DiffLine[]; lang: Lang }) {
  const keep = lines.map(
    (line, index) =>
      lineChanged(line) ||
      (!!lines[index - 1] && lineChanged(lines[index - 1]!)) ||
      (!!lines[index + 1] && lineChanged(lines[index + 1]!)),
  );
  const parts: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index;
    while (end < lines.length && keep[end] === keep[index]) end++;
    const run = lines.slice(index, end);
    parts.push(
      keep[index] ? (
        <Body key={index} lines={run} lang={lang} />
      ) : (
        <details key={index} className={styles.fold}>
          <summary>
            {count.format(run.length)} unchanged {run.length === 1 ? 'line' : 'lines'}
          </summary>
          <Body lines={run} lang={lang} />
        </details>
      ),
    );
    index = end;
  }
  return <>{parts}</>;
}

/** A changed language: removed words struck and added words in place, sized to the change. */
function TextChange({
  before,
  after,
  lang,
  hash,
  classification,
}: {
  before: string;
  after: string;
  lang: Lang;
  hash: number;
  classification: Classification | undefined;
}) {
  const data = useDataStore((state) => state.data);
  const globals = useMemo(() => reviewGlobals(data, lang, hash), [data, lang, hash]);
  const { result, busy } = useRenderedDiff(before, after, globals);
  const variants = classification?.variants;
  const scope = classification?.scope;
  const enhanced = useMemo(
    () =>
      variants && scope !== 'base'
        ? (result.enhanced ??
          presentDiff(
            renderedDiff(
              before,
              after,
              variantGlobals(globals, true),
              before.length + after.length <= 4000,
            ),
          ))
        : undefined,
    [variants, scope, result, before, after, globals],
  );
  const late = useDelayed(busy);
  if (busy)
    return late ? (
      <div className={styles.single} aria-busy="true">
        <SkeletonRegion>
          <SkeletonLine width={90} />
          <SkeletonLine width={70} />
        </SkeletonRegion>
      </div>
    ) : null;
  const column = (diff: ReturnType<typeof renderedDiff> | undefined) =>
    !diff ? undefined : diff.merged ? (
      <Folded lines={diff.merged} lang={lang} />
    ) : (
      // Tables keep the two sides: the live text, then the saved text. A global's language can be
      // added or removed whole, which has one side.
      <>
        {(hash >= 0 || diff.before.length > 0) && <Body lines={diff.before} lang={lang} />}
        {(hash >= 0 || diff.after.length > 0) && <Body lines={diff.after} lang={lang} />}
      </>
    );
  if (scope === 'enhanced')
    return <Columns lang={lang} enhanced={column(enhanced)} only="Enhanced" />;
  if (scope === 'base' && variants)
    return <Columns lang={lang} base={column(result)} only="Base" />;
  if (scope === 'both' && enhanced)
    return <Columns lang={lang} base={column(result)} enhanced={column(enhanced)} />;
  return <Columns lang={lang} base={column(result)} />;
}

/** Source lines that changed, with one line of context, line numbers, and changed characters. */
function RawMarkup({ before, after }: { before: string; after: string }) {
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts = diffWords(a.slice(start, endA).join('\n'), b.slice(start, endB).join('\n'));
  // Split the old (equal + deleted) and new (equal + inserted) sides into rows of marked runs.
  const rows = (side: 'delete' | 'insert', from: number, length: number) => {
    if (!length) return [];
    const lines: ReactNode[][] = [[]];
    for (const [index, part] of parts.entries()) {
      if (part.kind !== 'equal' && part.kind !== side) continue;
      part.text.split('\n').forEach((text, piece) => {
        if (piece) lines.push([]);
        if (!text) return;
        const key = `${index}:${piece}`;
        lines
          .at(-1)!
          .push(
            part.kind === 'equal' ? (
              <span key={key}>{text}</span>
            ) : side === 'delete' ? (
              <del key={key}>{text}</del>
            ) : (
              <ins key={key}>{text}</ins>
            ),
          );
      });
    }
    return lines.map((content, index) => ({
      number: from + index + 1,
      mark: side === 'delete' ? '−' : '+',
      content,
    }));
  };
  const context = (line: number, text: string | undefined) =>
    text === undefined ? [] : [{ number: line + 1, mark: '', content: [text] as ReactNode[] }];
  const all = [
    ...(start > 0 ? context(start - 1, a[start - 1]) : []),
    ...rows('delete', start, endA - start),
    ...rows('insert', start, endB - start),
    ...context(endB, b[endB]),
  ];
  return (
    <pre className={styles.raw}>
      {all.map((row, index) => (
        <span key={index} className={styles.rawLine} data-mark={row.mark || undefined}>
          <span className={styles.rawNumber} aria-hidden="true">
            {row.number}
          </span>
          <span className={styles.rawMark} aria-hidden="true">
            {row.mark}
          </span>
          <span>{row.content}</span>
        </span>
      ))}
    </pre>
  );
}

/** The open change: one sentence, who saved it, and only the evidence its kind needs. */
export const ReviewDetail = memo(function ReviewDetail({
  entry,
  published,
  classification,
  raw,
  onRetry,
}: {
  entry: PendingTooltip;
  published: Published | undefined;
  classification: Classification | undefined;
  /** Raw markup on (R). */
  raw: boolean;
  onRetry(): void;
}) {
  const user = useAuthStore((state) => state.user);
  const data = useDataStore((state) => state.data);
  const [saved, setSaved] = useState<HistoryCommit | null>();
  const pending = entry.part?.pending;
  // The last saver: one request for the open change only. Its line is reserved, so nothing
  // moves when it arrives, and it never blocks the rest.
  useEffect(() => {
    setSaved(undefined);
    if (!user?.role || pending) return;
    const controller = new AbortController();
    void getHistory(entry.tooltip.hash, 1, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSaved(result.commits[0] ?? null);
      },
      () => {
        if (!controller.signal.aborted) setSaved(null);
      },
    );
    return () => controller.abort();
  }, [entry.tooltip.hash, pending, user]);
  const live = published?.status === 'ready' ? published.tooltip : undefined;
  const kind = classification?.kind;
  const saverLine = pending ? (
    <GlobalSaver pending={pending} />
  ) : user?.role ? (
    <p className={styles.savedBy}>
      {saved && (
        <>
          Saved by <CommitAuthor entry={saved} />
        </>
      )}
    </p>
  ) : null;
  // The text a reader judges when there is no comparison: the saved text, plain.
  const savedText = (tooltip: Tooltip) =>
    Object.keys(tooltip.text).length
      ? (Object.entries(tooltip.text) as [Lang, { text: string }][])
          .filter(([, value]) => value?.text)
          .map(([lang, value], _, all) => (
            <section key={lang} lang={lang} aria-label={`${languageLabel(lang)} comparison`}>
              {(all.length > 1 || lang !== 'en') && <h4>{languageLabel(lang)}</h4>}
              <PlainText text={value.text} lang={lang} hash={entry.tooltip.hash} />
            </section>
          ))
      : null;
  let evidence: ReactNode = null;
  if ((kind === 'Text changed' || kind === 'Renamed') && live) {
    const changed = classification!.languages ?? textLanguages(live, entry.tooltip);
    evidence = changed.map((lang) => (
      <section key={lang} lang={lang} aria-label={`${languageLabel(lang)} comparison`}>
        {(changed.length > 1 || lang !== 'en') && <h4>{languageLabel(lang)}</h4>}
        <TextChange
          before={exportedText(live, lang)}
          after={exportedText(entry.tooltip, lang)}
          lang={lang}
          hash={entry.tooltip.hash}
          classification={classification}
        />
      </section>
    ));
  } else if (kind === 'Links changed' && live)
    evidence = (
      <div className={styles.links}>
        <CompendiumChanges before={live} current={entry.tooltip} />
        <FieldChanges
          before={live}
          current={entry.tooltip}
          item={data ? itemFor(entry.tooltip.hash, data) : undefined}
        />
      </div>
    );
  else if (kind === 'Removed') evidence = savedText(live ?? entry.tooltip);
  else if (kind === 'Output unchanged' || kind === 'Definition changed')
    evidence = savedText(entry.tooltip);
  else if (kind === 'New' || kind === 'Restored' || kind === 'On hold' || !kind) {
    // Unknown (loading, failed, signed out): the saved text renders plain so it can be judged.
    if (kind || published?.status !== 'loading') evidence = savedText(entry.tooltip);
  }
  // Raw markup of a globals entry is its whole declaration, not only the body that renders.
  const part = entry.part;
  const rawSource = (side: 'before' | 'after', lang: Lang) =>
    part
      ? (part.source[side][lang] ?? '')
      : ((side === 'before' ? live : entry.tooltip)?.text[lang]?.text ?? '');
  const rawLanguages = !live
    ? []
    : part
      ? languages.filter((lang) => rawSource('before', lang) !== rawSource('after', lang))
      : textLanguages(live, entry.tooltip);
  return (
    <section aria-label="Selected change" className={styles.detail}>
      <Sentence
        entry={entry}
        published={published}
        classification={classification}
        onRetry={onRetry}
      />
      {pending ? (
        <>
          {sameTextLanguages(pending).length > 0 && (
            <p className={styles.note}>
              {list(sameTextLanguages(pending).map((lang) => languageLabel(lang)))} keeps its text,
              but tooltips may switch between it and English.
            </p>
          )}
          <UpdatedTooltips pending={pending} />
        </>
      ) : (
        part && <GlobalNote entry={entry} part={part} />
      )}
      {saverLine}
      {entry.inactiveAliases?.length ? (
        <p className={styles.note}>
          Publishing this also applies the saved inactive decisions for alias hashes{' '}
          {entry.inactiveAliases.join(', ')}.
        </p>
      ) : null}
      <div className={styles.evidence}>{evidence}</div>
      {raw && live && rawLanguages.length > 0 && (
        <div className={styles.rawBlock} aria-label="Raw markup">
          {rawLanguages.map((lang) => (
            <div key={lang}>
              {(rawLanguages.length > 1 || lang !== 'en') && <h4>{languageLabel(lang)}</h4>}
              <RawMarkup before={rawSource('before', lang)} after={rawSource('after', lang)} />
            </div>
          ))}
        </div>
      )}
      {raw && live && !rawLanguages.length && <p className={styles.note}>Markup unchanged.</p>}
      {raw && live === null && (
        <p className={styles.note}>Raw markup compares with the published text: there is none.</p>
      )}
    </section>
  );
});

/**
 * "Restore live text as draft": loads the published text into a local draft after a confirm.
 * Nothing is saved or published.
 */
export function RestoreLive({
  entry,
  name = entry.name,
  published,
  className,
  onDone,
}: {
  entry: PendingTooltip;
  /** What the draft replaces (every entry of a globals file). */
  name?: string;
  published: Published | undefined;
  className?: string;
  onDone(message: string): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const user = useAuthStore((state) => state.user);
  const draft = useDraftStore((state) => state.drafts[entry.tooltip.hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const locked = useSaveState((state) => state.locked);
  const live = published?.status === 'ready' ? published.tooltip : null;
  if (!user?.role) return null;
  const canLoad =
    (user.role !== 'translator' || !!user.languages?.length) && hydrated && !locked && !!live;
  function load() {
    const currentUser = useAuthStore.getState().user;
    const state = useDraftStore.getState();
    if (
      !currentUser?.role ||
      (currentUser.role === 'translator' && !currentUser.languages?.length) ||
      !state.hydrated ||
      useSaveState.getState().locked ||
      !live
    )
      return;
    try {
      const saved = useDataStore.getState().data?.bundle.tooltips[entry.tooltip.hash];
      if (!saved) throw new Error('The saved tooltip is no longer available.');
      const existing = state.drafts[saved.hash];
      // Rebase only the fields this restore replaces; retain the old merge base
      // for any other local changes, including changes outside translator access.
      const base = revertDraft(existing?.base ?? saved, saved, currentUser);
      replaceDraft(
        base,
        revertDraft(existing?.next ?? saved, live, currentUser, undefined, true),
        true,
      );
      setConfirm(false);
      onDone(
        'Live text loaded as a local draft. Review it in the editor; nothing was saved or published.',
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!canLoad}
        title={live ? undefined : 'There is no published text to restore.'}
        onClick={() => {
          setError(undefined);
          setConfirm(true);
        }}
      >
        Restore live text as draft
      </button>
      {confirm && (
        <Dialog
          title="Restore live text as draft"
          compact
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" disabled={!canLoad} onClick={load}>
                Restore as draft
              </button>
              <button type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          }
        >
          <p>
            This replaces {draft ? 'the existing local draft' : 'the editor content'} for {name}{' '}
            with the live text. It does not save or publish.
          </p>
          {user.role === 'translator' && (
            <p>Only your assigned translation languages will be loaded.</p>
          )}
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </>
  );
}
