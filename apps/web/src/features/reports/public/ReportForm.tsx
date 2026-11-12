import { SkeletonBoundary } from '../../../ui/Skeleton';
import { languages } from '../../../../../../packages/core/src/languageCodes';
import type { ReportSubmission } from '../../../../../../packages/core/src/reports/schemas';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { languageLabel } from '../../../languageLabels';
import { categorySpecs } from '../../../services/categoryLabels';
import {
  publicAnchors,
  ReportApiError,
  waitText,
  type PublicAnchor,
} from '../../../services/reports';
import { useAuthStore } from '../../../stores/auth';
import { apiUrl } from '../../../services/apiAuth';
import { AnnotatedTooltip, type LineKey } from './AnnotatedTooltip';
import {
  anchorFor,
  browserLang,
  categoryLabels,
  defaultCategory,
  dropMarks,
  emptyDraft,
  isEmptyDraft,
  isWholeLine,
  lineMark,
  markRange,
  maxNoteLength,
  maxNotes,
  maxOverallLength,
  newCapability,
  noteId,
  reanchorDraft,
  readDraft,
  rememberRecent,
  rememberSecret,
  wordAt,
  wordsOf,
  writeDraft,
  type DraftNote,
  type Mark,
  type ReportCategory,
  type ReportDraft,
} from './draft';
import { ItemIdentity } from './ItemIdentity';
import { mountHumanCheck, type HumanCheck } from './turnstile';
import { maxScreenshots, prepareScreenshot, ScreenshotError, type Screenshot } from './screenshots';
import {
  lineAt,
  loadReportRender,
  reportItemCatalog,
  reportCatalog,
  type RenderLine,
  type ReportRender,
} from './tooltipRender';
import styles from './ReportPage.module.scss';

type SendClient = typeof import('./sendClient');
let sendClient: SendClient | undefined;
let sendClientLoad: Promise<SendClient> | undefined;
/** Send's schemas and calls, loaded once (a failed load is retried by the next call). */
function loadSendClient(): Promise<SendClient> {
  sendClientLoad ??= import('./sendClient').then(
    (client) => (sendClient = client),
    (error: unknown) => {
      sendClientLoad = undefined;
      throw error;
    },
  );
  return sendClientLoad;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown' }
  | { kind: 'ready'; render: ReportRender };
type Phase = 'refreshing' | 'idle' | 'checking' | 'check-failed' | 'sending' | 'uploading';
export interface ReceiptState {
  sent: true;
  name: string;
  lang: string;
  notes: number;
  viewed: number;
  owner: number;
  uploads: string[];
}

const anonymousWeight =
  'Anonymous reports count for much less than reports from signed-in community members.';
const burden =
  'The burden of proof is on you: add a screenshot or video link, where you tested, and the patch version.';
export const privacyLine =
  'Read by Clarity editors only. No email or IP is stored; your text and screenshots are never shown publicly. Signed-in reports show your GitHub name to editors.';
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** The form for one tooltip: mark text, write notes, add evidence, send (#/report/<hash>). */
export function ReportForm() {
  const { hash = '' } = useParams();
  const viewed = Number(hash);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedLang = params.get('lang') ?? browserLang();
  const quote = params.get('q');
  const src = params.get('src');
  const user = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.loading);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [existing, setExisting] = useState<PublicAnchor[]>([]);
  const [draft, setDraft] = useState<ReportDraft>(
    () => readDraft(viewed) ?? emptyDraft(requestedLang),
  );
  const restored = useRef(readDraft(viewed) !== undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [interactive, setInteractive] = useState(false);
  const check = useRef<HumanCheck | null>(null);
  const checkBox = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [optionalOpen, setOptionalOpen] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(min-width: 701px)').matches,
  );
  const formId = useId();
  const render = load.kind === 'ready' ? load.render : undefined;
  const busy =
    phase === 'refreshing' || phase === 'checking' || phase === 'sending' || phase === 'uploading';
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const renderRef = useRef(render);
  renderRef.current = render;
  const languageRef = useRef(requestedLang);
  languageRef.current = requestedLang;

  // Marks belong to the text they were made on: any locale change (the select, the URL, Back or
  // Forward) turns them into Re-mark notes against the text that is still on screen.
  useEffect(() => {
    if (!render || render.seenLang === requestedLang) return;
    setDraft((current) =>
      current.lang === render.seenLang
        ? dropMarks(current, render.display, requestedLang)
        : current,
    );
  }, [render, requestedLang]);

  // Load the catalog, then the tooltip in the requested language. Until it arrives the old text is
  // not shown (nothing can be marked or sent against it).
  useEffect(() => {
    let live = true;
    setLoad((current) =>
      current.kind === 'ready' &&
      current.render.viewed === viewed &&
      current.render.seenLang === requestedLang
        ? current
        : { kind: 'loading' },
    );
    reportItemCatalog(viewed)
      .then((catalog) => loadReportRender(viewed, requestedLang, catalog))
      .then(
        (next) => {
          if (!live) return;
          setLoad(next ? { kind: 'ready', render: next } : { kind: 'unknown' });
          if (next) rememberRecent(viewed);
        },
        (error: unknown) =>
          live &&
          setLoad({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [viewed, requestedLang, attempt]);

  // Open anchors from other players (optional: the form works without them).
  useEffect(() => {
    if (!render || !apiUrl) return;
    const controller = new AbortController();
    publicAnchors(render.item.owner, render.lang, controller.signal).then(setExisting, () =>
      setExisting([]),
    );
    return () => controller.abort();
  }, [render]);

  // A restored draft re-anchors by quote once the text is here; a deep link's quote is pre-marked.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!render || applied.current === `${render.seenLang}:${render.rev}`) return;
    applied.current = `${render.seenLang}:${render.rev}`;
    setDraft((current) => {
      if (restored.current) {
        restored.current = false;
        return current.lang === render.seenLang
          ? reanchorDraft(current, render.display, render.rev)
          : dropMarks(current, render.display, render.seenLang);
      }
      if (quote && isEmptyDraft(current)) {
        const at = render.display.indexOf(quote);
        if (at >= 0 && render.display.indexOf(quote, at + 1) < 0)
          return {
            ...current,
            notes: markRange([], { start: at, end: at + quote.length }, render.seenLang).notes,
          };
      }
      return { ...current, lang: render.seenLang };
    });
  }, [render, quote]);

  // Keep the draft in this tab (with quote anchors) so sign-in and reloads never lose it.
  useLayoutEffect(() => {
    if (!render || applied.current !== `${render.seenLang}:${render.rev}`) return;
    const anchors = Object.fromEntries(
      draft.notes
        .filter((note) => note.mark)
        .map((note) => [note.id, anchorFor(render.display, render.rev, render.lines, note.mark!)]),
    );
    writeDraft(viewed, isEmptyDraft(draft) ? undefined : { ...draft, anchors });
  }, [draft, render, viewed]);

  // The human check: anonymous and role-less accounts only, mounted once the page has painted.
  const needsCheck = Boolean(apiUrl) && !authLoading && !user?.role;
  // One mount at a time; a failed mount (script blocked, offline) is retried by the next Send.
  const mounting = useRef<Promise<HumanCheck> | null>(null);
  const checkGeneration = useRef(0);
  const ensureCheck = useCallback((): Promise<HumanCheck> => {
    if (check.current) return Promise.resolve(check.current);
    if (mounting.current) return mounting.current;
    const container = checkBox.current;
    if (!container) return Promise.reject(new Error('No human check container'));
    const generation = checkGeneration.current;
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const attempt = mountHumanCheck(container, setInteractive, theme).then(
      (mounted) => {
        if (generation !== checkGeneration.current) {
          mounted.remove();
          throw new Error('The human check was replaced');
        }
        check.current = mounted;
        mounting.current = null;
        return mounted;
      },
      (error: unknown) => {
        if (generation === checkGeneration.current) mounting.current = null;
        throw error;
      },
    );
    mounting.current = attempt;
    return attempt;
  }, []);
  useEffect(() => {
    if (!needsCheck || !render) return;
    ensureCheck().catch(() => undefined);
    return () => {
      checkGeneration.current += 1;
      mounting.current = null;
      check.current?.remove();
      check.current = null;
    };
  }, [needsCheck, render, ensureCheck]);

  useEffect(() => () => screenshots.forEach((shot) => URL.revokeObjectURL(shot.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Whether this form is still the one on screen (a late send result must not act for another).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const clearError = (key: string) =>
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });

  const updateNotes = useCallback(
    (change: (notes: DraftNote[]) => DraftNote[]) =>
      setDraft((current) => ({ ...current, notes: change(current.notes) })),
    [],
  );

  const added = (notes: DraftNote[], id: string | undefined) => {
    const n = notes.findIndex((note) => note.id === id) + 1;
    if (n) setAnnounce(`Note ${n} added`);
  };

  // The Re-mark note the next mark reconnects to ("Mark again"); the first one by default.
  const retarget = useRef<string | null>(null);
  const [targeted, setTargeted] = useState<string | null>(null);
  const markAgain = (id: string) => {
    retarget.current = id;
    setTargeted(id);
    document.querySelector<HTMLElement>(`.${styles.annotatable} [data-line]`)?.focus();
  };

  const mark = useCallback(
    (range: Mark) => {
      if (!render || busyRef.current) return;
      setDraft((current) => {
        if (
          current.notes.length >= maxNotes &&
          !current.notes.some((n) => !n.mark && n.remark) &&
          !current.notes.some((n) => n.mark && n.mark.start < range.end && range.start < n.mark.end)
        ) {
          setNotice('Up to 5 notes. Remove one to mark more.');
          return current;
        }
        const result = markRange(
          current.notes,
          range,
          render.seenLang,
          retarget.current ?? undefined,
        );
        if (result.added) added(result.notes, result.id);
        if (result.reconnected) {
          retarget.current = null;
          setTargeted(null);
          setAnnounce(`Note ${result.notes.findIndex((n) => n.id === result.id) + 1} marked again`);
        }
        return { ...current, notes: result.notes };
      });
    },
    [render],
  );

  const onTap = useCallback(
    (line: RenderLine, at: number) => {
      if (!render || busyRef.current) return;
      const hit = draft.notes.find(
        (note) => note.mark && at >= note.mark.start && at < note.mark.end,
      );
      if (hit) {
        if (isWholeLine(render.display, line, hit.mark)) {
          const word = wordAt(render.display, line, at);
          if (word)
            updateNotes((notes) => notes.map((n) => (n.id === hit.id ? { ...n, mark: word } : n)));
        } else document.getElementById(`field-${hit.id}`)?.focus({ preventScroll: coarse() });
        return;
      }
      const whole = lineMark(render.display, line);
      if (whole) mark(whole);
    },
    [render, draft.notes, mark, updateNotes],
  );

  const onSelect = useCallback(
    (range: Mark, extend: boolean) => {
      if (!render || busyRef.current) return;
      const line = lineAt(render.lines, range.start);
      // Trim selection whitespace so a quote never starts or ends with a space.
      let { start, end } = range;
      while (start < end && /\s/.test(render.display[start])) start++;
      while (end > start && /\s/.test(render.display[end - 1])) end--;
      if (end <= start || !line) return;
      if (extend) {
        const hit = draft.notes.find((n) => n.mark && n.mark.start < end && start < n.mark.end);
        if (hit) {
          updateNotes((notes) =>
            notes.map((n) => (n.id === hit.id ? { ...n, mark: { start, end } } : n)),
          );
          return;
        }
      }
      mark({ start, end });
    },
    [render, draft.notes, mark, updateNotes],
  );

  const onLineKey = useCallback(
    (line: RenderLine, key: LineKey) => {
      if (!render || busyRef.current) return;
      const whole = lineMark(render.display, line);
      if (!whole) return;
      const onLine = draft.notes
        .filter((n) => n.mark && n.mark.start >= line.start && n.mark.end <= line.end)
        .at(-1);
      if (key === 'mark') {
        if (onLine && isWholeLine(render.display, line, onLine.mark))
          setAnnounce('This line is already marked');
        else mark(whole);
        return;
      }
      const words = wordsOf(render.display, line);
      if (!words.length) return;
      if (!onLine) return mark(key === 'next' ? words[0] : words.at(-1)!);
      const index = words.findIndex(
        (w) => w.start === onLine.mark!.start && w.end === onLine.mark!.end,
      );
      const next = isWholeLine(render.display, line, onLine.mark)
        ? key === 'next'
          ? words[0]
          : words.at(-1)!
        : index < 0
          ? words[0]
          : words[Math.min(words.length - 1, Math.max(0, index + (key === 'next' ? 1 : -1)))];
      updateNotes((notes) => notes.map((n) => (n.id === onLine.id ? { ...n, mark: next } : n)));
      setAnnounce(`Note marks "${render.display.slice(next.start, next.end)}"`);
    },
    [render, draft.notes, mark, updateNotes],
  );

  const addWhole = () => {
    const note: DraftNote = { id: noteId(), category: 'missing', text: '', mark: null };
    setDraft((current) => ({ ...current, notes: [...current.notes, note] }));
    setAnnounce(`Note ${draft.notes.length + 1} added for the whole tooltip`);
    requestAnimationFrame(() => document.getElementById(`field-${note.id}`)?.focus());
  };
  const hasWhole = draft.notes.some((note) => !note.mark && !note.remark);

  const removeNote = (id: string) => {
    const n = draft.notes.findIndex((note) => note.id === id) + 1;
    updateNotes((notes) => notes.filter((note) => note.id !== id));
    setAnnounce(`Note ${n} removed`);
    setErrors((current) => {
      const { [`note-${id}`]: _removed, ...rest } = current;
      void _removed;
      return rest;
    });
  };

  const changeLang = (lang: string) => {
    if (render) setDraft((current) => dropMarks(current, render.display, lang));
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('lang', lang);
        next.delete('q');
        return next;
      },
      { replace: true },
    );
  };

  const attach = async (list: FileList | null) => {
    if (!list) return;
    const room = maxScreenshots - screenshots.length;
    const chosen = [...list].slice(0, room);
    const problems: string[] = [];
    if (list.length > room) problems.push(`Up to ${maxScreenshots} screenshots.`);
    const prepared: Screenshot[] = [];
    for (const file of chosen) {
      try {
        prepared.push(await prepareScreenshot(file));
      } catch (error) {
        problems.push(
          error instanceof ScreenshotError ? error.message : `${file.name} could not be attached.`,
        );
      }
    }
    setScreenshots((current) => [...current, ...prepared].slice(0, maxScreenshots));
    setErrors((current) => ({ ...current, screenshots: problems.join(' ') }));
  };

  /** Field errors in screen order; the first one is focused. */
  const validate = (
    client: SendClient,
    payload: Omit<ReportSubmission, 'turnstile'>,
  ): Record<string, string> => {
    const found: Record<string, string> = {};
    if (!draft.notes.length)
      found.tooltip = coarse()
        ? 'Tap the text that is wrong, or add Whole tooltip.'
        : 'Mark the text that is wrong, or add Whole tooltip.';
    draft.notes.forEach((note, index) => {
      const n = index + 1;
      if (note.remark && !note.mark)
        found[`note-${note.id}`] = `Mark the text for note ${n} again, or remove the note.`;
      else if (note.mark && !note.text.trim())
        found[`note-${note.id}`] = `Add a note for mark ${n}, or remove the mark.`;
      else if (!note.mark && !note.text.trim() && !draft.overall.trim())
        found[`note-${note.id}`] = 'Describe what is missing, or write an overall note.';
    });
    draft.links.forEach((link, index) => {
      if (!link.trim()) return;
      const parsed = client.reportVideoSchema.safeParse(link.trim());
      if (!parsed.success)
        found[`link-${index}`] = /discord/i.test(link)
          ? 'Discord links expire after a day; use YouTube, Twitch clips, Streamable, or imgur.'
          : `Use a link from ${client.reportVideoHosts.join(', ')}.`;
    });
    if (draft.source.trim() && !/^https:\/\/\S+$/.test(draft.source.trim()))
      found.source = 'Use an https:// link.';
    if (Object.keys(found).length) return found;
    // The shared schema is the final word (lengths, control and bidi characters).
    const result = client.reportSubmissionSchema.safeParse(payload);
    if (!result.success)
      for (const issue of result.error.issues) {
        const [field, index] = issue.path;
        const key =
          field === 'notes' && typeof index === 'number' && draft.notes[index]
            ? `note-${draft.notes[index].id}`
            : field === 'links' && typeof index === 'number'
              ? `link-${index}`
              : field === 'source_url'
                ? 'source'
                : field === 'note'
                  ? 'overall'
                  : 'form';
        found[key] ??= issue.message;
      }
    return found;
  };

  const focusError = (found: Record<string, string>) => {
    const order = [
      'tooltip',
      ...draft.notes.map((note) => `note-${note.id}`),
      'screenshots',
      ...draft.links.map((_, index) => `link-${index}`),
      'overall',
      'source',
      'form',
    ];
    const first = order.find((key) => found[key]);
    if (first === 'overall' || first === 'source') setOptionalOpen(true);
    requestAnimationFrame(() => {
      const target =
        first === 'tooltip'
          ? document.querySelector<HTMLElement>(`.${styles.annotatable} [data-line]`)
          : first?.startsWith('note-')
            ? document.getElementById(`field-${first.slice(5)}`)
            : first
              ? document.getElementById(`${formId}-${first}`)
              : null;
      target?.focus();
    });
  };

  // Refresh the live catalog before each new submission as well as first paint.
  // Keep idempotent retries on their original payload; the Worker checks them first.
  const refreshForSend = async (): Promise<boolean> => {
    if (!render) return false;
    const current = () =>
      alive.current && renderRef.current === render && languageRef.current === requestedLang;
    try {
      const latest = await reportCatalog(true);
      const next = await loadReportRender(viewed, requestedLang, latest);
      if (!current()) {
        if (alive.current) {
          setPhase('idle');
          busyRef.current = false;
        }
        return false;
      }
      if (!next) {
        setLoad({ kind: 'unknown' });
        setPhase('idle');
        busyRef.current = false;
        return false;
      }
      const identityChanged =
        next.item.owner !== render.item.owner ||
        next.item.variant !== render.item.variant ||
        next.item.type !== render.item.type ||
        next.lang !== render.lang ||
        next.rev !== render.rev ||
        next.display !== render.display;
      if (
        identityChanged ||
        next.dataCommit !== render.dataCommit ||
        JSON.stringify(next.item) !== JSON.stringify(render.item)
      ) {
        // Quotes belong to the old display, never to offsets in replacement text.
        setDraft((previous) =>
          identityChanged
            ? dropMarks(previous, render.display, next.seenLang)
            : { ...previous, pending: undefined },
        );
        applied.current = `${next.seenLang}:${next.rev}`;
        setExisting([]);
        setLoad({ kind: 'ready', render: next });
        setPhase('idle');
        busyRef.current = false;
        setNotice(
          identityChanged
            ? 'The tooltip changed. Re-mark notes, then send again.'
            : 'The tooltip data was refreshed. Review it and send again; your notes are kept.',
        );
        return false;
      }
      return true;
    } catch {
      if (current()) {
        setPhase('idle');
        busyRef.current = false;
        setNotice('Could not check the latest tooltip. Your notes are kept; try again.');
      } else if (alive.current) {
        setPhase('idle');
        busyRef.current = false;
      }
      return false;
    }
  };

  // Send's code arrives once there is something to send, before the reporter presses Send.
  useEffect(() => {
    if (render && !isEmptyDraft(draft)) loadSendClient().catch(() => undefined);
  }, [render, draft]);
  const waitingForClient = useRef(false);

  const send = async () => {
    if (!render || busyRef.current) return;
    const client = sendClient;
    if (!client) {
      // Sent before the prefetch finished (or it failed): load it, then send with the latest form.
      if (waitingForClient.current) return;
      waitingForClient.current = true;
      try {
        await loadSendClient();
      } catch {
        if (alive.current)
          setNotice('The report could not be sent. Check your connection and try again.');
        return;
      } finally {
        waitingForClient.current = false;
      }
      if (alive.current) await sendRef.current();
      return;
    }
    setNotice(null);
    const anchors = draft.notes.map((note) =>
      note.mark ? anchorFor(render.display, render.rev, render.lines, note.mark) : null,
    );
    const body = {
      viewed_hash: viewed,
      owner_hash: render.item.owner,
      variant: render.item.variant,
      lang: render.lang,
      ...(render.fallback ? { seen_lang: render.seenLang } : {}),
      rev: render.rev,
      data_commit: render.dataCommit,
      category: draft.notes[0]?.category ?? defaultCategory(render.seenLang),
      note: draft.overall.trim(),
      notes: draft.notes.map((note, index) => ({
        category: note.category,
        text: note.text.trim(),
        anchor: anchors[index],
      })),
      ...(draft.source.trim() ? { source_url: draft.source.trim() } : {}),
      ...(src ? { src: src.slice(0, 64) } : {}),
      links: draft.links.map((link) => link.trim()).filter(Boolean),
    } as const;
    // Same payload as an unanswered attempt → same request id (a retry); otherwise a new report.
    // Older tabs may retain an unanswered request from before mapping fields existed.
    // Retry that exact payload so a stored row can return its original receipt/secret;
    // the Worker refuses missing mapping fields if the request was never stored.
    const legacySignature = JSON.stringify({ ...body, owner_hash: undefined, variant: undefined });
    const legacyRetry = draft.pending?.payload === legacySignature;
    const submissionBody = legacyRetry
      ? { ...body, owner_hash: undefined, variant: undefined }
      : body;
    const signature = JSON.stringify(submissionBody);
    const capability =
      draft.pending?.payload === signature
        ? draft.pending
        : { ...newCapability(), payload: signature };
    const payload = {
      ...submissionBody,
      request_id: capability.requestId,
      withdraw_secret: capability.secret,
    };
    const found = validate(client, payload as Omit<ReportSubmission, 'turnstile'>);
    setErrors(found);
    if (Object.keys(found).length) return focusError(found);
    busyRef.current = true;
    if (draft.pending?.payload !== signature) {
      setPhase('refreshing');
      if (!(await refreshForSend())) return;
    }
    const kept = { ...draft, pending: capability };
    setDraft(kept);
    writeDraft(viewed, kept);
    let token: string | undefined;
    if (needsCheck) {
      setPhase('checking');
      let human: HumanCheck;
      try {
        human = await ensureCheck();
      } catch {
        setPhase('check-failed');
        setNotice('The human check could not load. Check your connection and send again.');
        return;
      }
      try {
        token = await human.token();
      } catch {
        setPhase('check-failed');
        return;
      }
    }
    setPhase('sending');
    try {
      const result = await client.submitReport({
        ...payload,
        ...(token ? { turnstile: token } : {}),
      });
      rememberSecret(result.id, capability.secret);
      const uploads: string[] = [];
      if (user && screenshots.length) {
        setPhase('uploading');
        for (const [index, shot] of screenshots.entries()) {
          try {
            await client.uploadScreenshot(result.id, capability.requestId, shot.blob);
          } catch (error) {
            uploads.push(
              `Screenshot ${index + 1}: ${error instanceof ReportApiError ? error.message : 'not uploaded'}.`,
            );
            if (error instanceof ReportApiError && [403, 409].includes(error.status)) break;
          }
        }
      }
      // This form may be gone (the reporter left, maybe came back and kept writing): then only
      // the submitted draft itself is cleared; newer text stays, and the page stays where it is.
      if (!alive.current) {
        const stored = readDraft(viewed);
        if (stored?.pending?.requestId === capability.requestId)
          writeDraft(
            viewed,
            JSON.stringify(stored.notes) === JSON.stringify(kept.notes) &&
              stored.overall === kept.overall &&
              stored.source === kept.source &&
              JSON.stringify(stored.links) === JSON.stringify(kept.links)
              ? undefined
              : { ...stored, pending: undefined },
          );
        return;
      }
      writeDraft(viewed, undefined);
      const state: ReceiptState = {
        sent: true,
        name: render.item.name,
        lang: render.lang,
        notes: draft.notes.length,
        viewed,
        owner: render.item.owner,
        uploads,
      };
      navigate(`/report/r/${result.id}`, { state });
    } catch (error) {
      const refused =
        error instanceof ReportApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 409;
      if (!alive.current) {
        const stored = readDraft(viewed);
        if (refused && stored?.pending?.requestId === capability.requestId)
          writeDraft(viewed, { ...stored, pending: undefined });
        return;
      }
      check.current?.reset();
      if (
        error instanceof ReportApiError &&
        error.status === 409 &&
        error.message === 'Tooltip data changed; reload before sending'
      ) {
        setDraft((previous) => ({ ...previous, pending: undefined }));
        setPhase('refreshing');
        if (await refreshForSend()) {
          setPhase('idle');
          busyRef.current = false;
          setNotice('The report catalog is updating. Your notes are kept; try again shortly.');
        }
        return;
      }
      setPhase(
        error instanceof ReportApiError && error.message.startsWith('Human check')
          ? 'check-failed'
          : 'idle',
      );
      setNotice(sendFailure(error));
      // A refused report is final for this payload: the next send is a new attempt.
      if (refused) setDraft((current) => ({ ...current, pending: undefined }));
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const hint = useMemo(
    () =>
      coarse()
        ? 'Tap the line that is wrong, then tap a word to narrow it. Dashed text already has an open report. Up to 5 notes.'
        : 'Select the text that is wrong: drag, click a line, or Tab to a line and press Enter (Shift+←/→ narrows). Dashed text already has an open report. Up to 5 notes.',
    [],
  );

  const renderContent = () => {
    if (load.kind === 'loading') return null;
    if (load.kind === 'failed')
      return (
        <div className={styles.page}>
          <div role="alert" className={styles.notice}>
            <p>The tooltip could not load: {load.message}</p>
            <button
              type="button"
              className={styles.button}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      );
    if (load.kind === 'unknown')
      return (
        <div className={styles.page}>
          <p role="alert" className={styles.notice}>
            Item {hash} has no Clarity tooltip to report.{' '}
            <Link to="/report">Search for it by name</Link>.
          </p>
        </div>
      );
    const r = load.render;
    const refreshed =
      notice?.startsWith('The tooltip changed.') ||
      notice?.startsWith('The tooltip data was refreshed.');
    const sendNotice = refreshed ? errors.form : (notice ?? errors.form);
    const category = categorySpecs[r.item.category]?.label ?? r.item.type;
    const status =
      phase === 'refreshing'
        ? 'Checking the latest tooltip…'
        : phase === 'checking'
          ? 'Checking…'
          : phase === 'check-failed'
            ? 'Check failed, retry'
            : phase === 'sending'
              ? 'Sending…'
              : phase === 'uploading'
                ? 'Uploading screenshots…'
                : needsCheck
                  ? 'Human check runs when you send'
                  : '';

    return (
      <form
        className={`${styles.page} ${styles.form}`}
        aria-label={`Report an issue with ${r.item.name}`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {/* Frozen while the check, the send, and the uploads run: what is sent is what is shown. */}
        <fieldset className={styles.frozen} disabled={busy}>
          <section className={styles.left} aria-label="Tooltip">
            <div className={styles.itemRow}>
              <ItemIdentity item={r.item} category={category} hash={viewed} />
              <span className={styles.itemControls}>
                <Link className={styles.linkButton} to={`/report?lang=${r.seenLang}`}>
                  Change
                </Link>
                <label className={styles.langField}>
                  <span className={styles.visuallyHidden}>Language</span>
                  <select
                    className={styles.select}
                    value={r.seenLang}
                    onChange={(event) => changeLang(event.target.value)}
                  >
                    {languages.map((lang) => (
                      <option key={lang} value={lang}>
                        {languageLabel(lang)}
                      </option>
                    ))}
                  </select>
                </label>
              </span>
            </div>
            {refreshed && (
              <p className={styles.notice} role="alert">
                {notice}
              </p>
            )}
            {r.fallback && (
              <p className={styles.fallback}>
                No {languageLabel(r.seenLang)} text yet; shown in English. Report a missing
                translation with Whole tooltip.
              </p>
            )}
            <p className={styles.hint}>{hint}</p>
            <AnnotatedTooltip
              render={r}
              notes={draft.notes}
              existing={existing}
              onTap={onTap}
              onSelect={onSelect}
              onLineKey={onLineKey}
            />
            {errors.tooltip && (
              <p className={styles.error} role="alert">
                {errors.tooltip}
              </p>
            )}
            <p className={styles.muted}>
              Shown at consumer width, so the lines break as they did in your app.
            </p>
            <button
              type="button"
              className={`${styles.textButton} ${styles.flush}`}
              onClick={addWhole}
              disabled={hasWhole || draft.notes.length >= maxNotes}
              title={
                hasWhole
                  ? 'A Whole tooltip note is already there'
                  : draft.notes.length >= maxNotes
                    ? 'Up to 5 notes'
                    : 'For missing information or a problem with the whole tooltip'
              }
            >
              + Whole tooltip
            </button>
            <p className={`${styles.muted} ${styles.privacyWide}`}>{privacyLine}</p>
          </section>

          <section className={styles.right} aria-label="Notes">
            {draft.notes.length > 0 && <h2 className={styles.heading}>Notes</h2>}
            <ol className={styles.notes}>
              {draft.notes.map((note, index) => (
                <NoteRow
                  key={note.id}
                  n={index + 1}
                  note={note}
                  quote={note.mark ? r.display.slice(note.mark.start, note.mark.end) : undefined}
                  error={errors[`note-${note.id}`]}
                  onChange={(next) => {
                    clearError(`note-${note.id}`);
                    updateNotes((notes) =>
                      notes.map((n) => (n.id === note.id ? { ...n, ...next } : n)),
                    );
                  }}
                  onRemove={() => removeNote(note.id)}
                  targeted={targeted === note.id}
                  onMarkAgain={() => markAgain(note.id)}
                />
              ))}
            </ol>

            <h2 className={styles.heading}>Evidence</h2>
            <div className={styles.evidence}>
              {user ? (
                <div className={styles.shots}>
                  <button
                    type="button"
                    className={styles.button}
                    id={`${formId}-screenshots`}
                    onClick={() => files.current?.click()}
                    disabled={screenshots.length >= maxScreenshots}
                    title={screenshots.length >= maxScreenshots ? 'Up to 3 screenshots' : undefined}
                  >
                    Attach screenshots (up to 3)
                  </button>
                  <input
                    ref={files}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      void attach(event.target.files);
                      event.target.value = '';
                    }}
                  />
                  {screenshots.map((shot, index) => (
                    <span key={shot.id} className={styles.thumb}>
                      <img src={shot.url} alt={`Screenshot ${index + 1}`} />
                      <button
                        type="button"
                        className={styles.thumbRemove}
                        aria-label={`Remove screenshot ${index + 1}`}
                        onClick={() => {
                          URL.revokeObjectURL(shot.url);
                          setScreenshots((current) => current.filter((s) => s.id !== shot.id));
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className={styles.muted}>
                  Sign in to attach screenshots; video links work for everyone.
                </p>
              )}
              {errors.screenshots && (
                <p className={styles.error} role="alert">
                  {errors.screenshots}
                </p>
              )}
              {draft.links.map((link, index) => (
                <div key={index} className={styles.fieldRow}>
                  <label htmlFor={`${formId}-link-${index}`} className={styles.label}>
                    Video link{' '}
                    <span className={styles.labelNote}>(YouTube, Twitch, Streamable, imgur)</span>
                  </label>
                  <input
                    id={`${formId}-link-${index}`}
                    className={styles.input}
                    type="url"
                    inputMode="url"
                    value={link}
                    aria-invalid={Boolean(errors[`link-${index}`]) || undefined}
                    placeholder="https://"
                    onChange={(event) => {
                      clearError(`link-${index}`);
                      setDraft((current) => ({
                        ...current,
                        links: current.links.map((l, i) => (i === index ? event.target.value : l)),
                      }));
                    }}
                  />
                  {errors[`link-${index}`] && (
                    <p className={styles.error} role="alert">
                      {errors[`link-${index}`]}
                    </p>
                  )}
                </div>
              ))}
              {draft.links.length < 2 && draft.links[0]?.trim() && (
                <button
                  type="button"
                  className={`${styles.textButton} ${styles.flush}`}
                  onClick={() =>
                    setDraft((current) => ({ ...current, links: [...current.links, ''] }))
                  }
                >
                  + Another video link
                </button>
              )}
            </div>

            <details
              className={styles.optional}
              open={optionalOpen}
              onToggle={(event) => setOptionalOpen(event.currentTarget.open)}
            >
              <summary>Add an overall note or a source link</summary>
              <label htmlFor={`${formId}-overall`} className={styles.label}>
                Overall note
              </label>
              <textarea
                id={`${formId}-overall`}
                className={styles.textarea}
                rows={2}
                maxLength={maxOverallLength}
                value={draft.overall}
                aria-invalid={Boolean(errors.overall) || undefined}
                placeholder="What should change, where you saw it"
                onChange={(event) => {
                  clearError('overall');
                  setDraft((current) => ({ ...current, overall: event.target.value }));
                }}
              />
              {errors.overall && <p className={styles.error}>{errors.overall}</p>}
              <label htmlFor={`${formId}-source`} className={styles.label}>
                Source link
              </label>
              <input
                id={`${formId}-source`}
                className={styles.input}
                type="url"
                inputMode="url"
                value={draft.source}
                aria-invalid={Boolean(errors.source) || undefined}
                placeholder="https://"
                onChange={(event) => {
                  clearError('source');
                  setDraft((current) => ({ ...current, source: event.target.value }));
                }}
              />
              {errors.source && <p className={styles.error}>{errors.source}</p>}
            </details>

            <p className={styles.identity}>
              {authLoading ? (
                'Checking sign-in…'
              ) : user ? (
                <>
                  Reporting as <strong>{user.login}</strong>.
                </>
              ) : (
                <>
                  Reporting as <strong>Anonymous</strong>. Sign in (top right) to use your name;
                  your notes are kept.
                </>
              )}
            </p>
            {!user?.role && (
              <p className={styles.burden}>{user ? burden : `${anonymousWeight} ${burden}`}</p>
            )}
            <p className={`${styles.muted} ${styles.privacyNarrow}`}>{privacyLine}</p>

            <div className={styles.footer} data-refreshed={refreshed || undefined}>
              <div className={styles.checkRow} data-visible={interactive || undefined}>
                <div ref={checkBox} />
              </div>
              {sendNotice && (
                <p className={styles.notice} role="alert">
                  {sendNotice}
                </p>
              )}
              <div className={styles.bar}>
                <span className={styles.barStatus} role="status">
                  {status}
                </span>
                <button
                  type="submit"
                  className={styles.primary}
                  aria-disabled={busy || undefined}
                  title={busy ? status : undefined}
                >
                  {phase === 'check-failed' ? 'Retry send' : 'Send report'}
                </button>
              </div>
            </div>
          </section>
        </fieldset>
        <p className={styles.visuallyHidden} aria-live="polite">
          {announce}
        </p>
      </form>
    );
  };
  return (
    <SkeletonBoundary
      pending={load.kind === 'loading'}
      error={load.kind === 'failed' || load.kind === 'unknown'}
      identity={hash}
      label="Loading the tooltip…"
    >
      {renderContent()}
    </SkeletonBoundary>
  );
}

function sendFailure(error: unknown): string {
  if (!(error instanceof ReportApiError)) return 'The report could not be sent. Try again.';
  const kept = 'Your notes are kept on this device.';
  if (error.status === 0) return `Reports are unavailable right now. ${kept}`;
  if (error.status === 429) {
    const wait = error.retryAfter ? ` Try again in ${waitText(error.retryAfter)}.` : '';
    const what =
      error.limitKey === 'ipday' || error.limitKey === 'acc'
        ? 'You have sent the most reports allowed today.'
        : error.limitKey === 'attempt10m'
          ? 'Too many human checks in a short time.'
          : 'Too many reports in a short time.';
    return `${what}${wait} ${kept}`;
  }
  if (error.status === 503)
    return `${error.message}.${error.retryAfter ? ` Try again in ${waitText(error.retryAfter)}.` : ''} ${kept}`;
  if (error.message.startsWith('Human check')) return `${error.message}. ${kept}`;
  return `${error.message}. ${kept}`;
}

function NoteRow({
  n,
  note,
  quote,
  error,
  onChange,
  onRemove,
  targeted,
  onMarkAgain,
}: {
  n: number;
  note: DraftNote;
  quote?: string;
  error?: string;
  onChange(next: Partial<DraftNote>): void;
  onRemove(): void;
  targeted: boolean;
  onMarkAgain(): void;
}) {
  const errorId = `note-${note.id}-error`;
  return (
    <li className={styles.note} id={`note-${note.id}`}>
      <span className={styles.noteBadge} aria-hidden="true">
        {n}
      </span>
      <div className={styles.noteBody}>
        <p className={styles.quote}>
          {quote !== undefined ? (
            <q>{quote}</q>
          ) : note.remark ? (
            <>
              <q>{note.remark}</q>{' '}
              <span className={styles.warnText}>Mark it again to reconnect this note</span>
            </>
          ) : (
            'Whole tooltip'
          )}
        </p>
        <label className={styles.visuallyHidden} htmlFor={`field-${note.id}`}>
          Note {n}
        </label>
        <textarea
          id={`field-${note.id}`}
          className={styles.textarea}
          rows={2}
          maxLength={maxNoteLength}
          value={note.text}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder="What did you see, where did you test it, which patch?"
          onChange={(event) => onChange({ text: event.target.value })}
        />
        {error && (
          <p id={errorId} className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.noteActions}>
          <label className={styles.visuallyHidden} htmlFor={`category-${note.id}`}>
            Category of note {n}
          </label>
          <select
            id={`category-${note.id}`}
            className={styles.select}
            value={note.category}
            onChange={(event) => onChange({ category: event.target.value as ReportCategory })}
          >
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {!note.mark && note.remark && (
            <button
              type="button"
              className={styles.textButton}
              aria-pressed={targeted}
              onClick={onMarkAgain}
            >
              {targeted ? 'Mark it in the tooltip' : 'Mark again'}
            </button>
          )}
          <button type="button" className={styles.textButton} onClick={onRemove}>
            Remove note
          </button>
        </div>
      </div>
    </li>
  );
}
