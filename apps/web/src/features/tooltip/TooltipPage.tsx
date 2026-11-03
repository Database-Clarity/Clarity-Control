import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { AttachmentCategoryControl } from './AttachmentCategoryControl';
import { useCompendiumStore } from '../compendium/store';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { translationQueue, type Lang, type MarkupGlobals, type Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { tooltipImports } from '../../services/tooltipImports';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { usePausedForOtherTab, useConflictStore } from '../../stores/conflicts';
import { ConflictRows } from '../conflicts/ConflictRows';
import { previewDrafts } from '../conflicts/previewDrafts';
import { theirsLabel } from '../conflicts/rebase';
import type { CompareData } from '../conflicts/CompareView';
import { useAuthStore } from '../../stores/auth';
import {
  canonicalHash,
  sharedPerkLabel,
  singleOwnerLabel,
  tooltipFor,
  variantHashes,
} from '../navigation/catalog';
import { tooltipPath } from '../navigation/stepping';
import { ShellSlot } from '../navigation/ShellSlots';
import { useShellColumn } from '../navigation/ShellColumnContext';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { ClarityEditor } from '../editor';
import { tooltipTextSources } from '../editor/references';
import { corpusUsage } from '../editor/suggest/usage';
import type { TooltipTarget } from '../editor/referenceActions';
import { PreviewColumn, type EnhancedView } from '../preview';
import { effectiveMode, previewedHashes, type PreviewMode } from '../preview/previewMode';
import { useAcknowledgePreview } from '../navigation/useAcknowledgePreview';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { HistoryPanel } from '../history/HistoryPanel';
import { useSaveState } from '../../services/save/state';
import { AssociationsPanel } from '../associations/AssociationsPanel';
import { PanelRow } from '../../ui/PanelRow';
import { languageLabel } from '../../languageLabels';
import { editorAccess } from './access';
import { defaultLanguage, withLanguage } from './language';
import { LanguageSummary } from './LanguageSummary';
import { EditorPaneHeader } from './EditorPaneHeader';
import { TranslationSource } from './TranslationSource';
import { VariantWorkspace } from './VariantWorkspace';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import {
  editableOverrides,
  enhancedRender,
  previewedVariants,
  storedFormVariants,
} from './variants';
import styles from './TooltipPage.module.scss';

/**
 * The editor page (variant model D): ONE base editor per item, whatever the role. Enhanced
 * versions are derived from the base text and shown in the preview; the few that keep text of
 * their own open in the same editor slot through "Edit override" (the base editor stays mounted
 * underneath, so its caret and undo history survive the round trip).
 */
export function TooltipPage({
  hashOverride,
  readOnly = false,
}: {
  hashOverride?: number;
  readOnly?: boolean;
}) {
  const compendiumSource = useCompendiumStore((state) => state.data);
  const { hash: parameter } = useParams();
  const [search, setSearch] = useSearchParams();
  const data = useDataStore((state) => state.data);
  const [remembered, setRemembered] = useState<Lang>();
  // The enhanced version whose own text is open in the editor (null: the base). Keyed by item, so
  // moving to another tooltip starts on its base.
  const [picked, setPicked] = useState<{ hash: number; variant: number | null }>();
  // The preview column's view (null: Compare on a desktop, Enhanced on a phone) and, when an item
  // has several enhanced versions, which one. Both are working choices, never saved.
  const [previewMode, setPreviewMode] = useState<PreviewMode | null>(null);
  const [previewPick, setPreviewPick] = useState<{ hash: number; variant: number }>();
  const phone = useMedia(phoneQuery);
  const user = useAuthStore((state) => state.user);
  const lang = defaultLanguage(user, search, remembered);
  function changeLanguage(next: Lang) {
    setRemembered(next);
    setSearch(withLanguage(search, next));
  }
  const highlightLine = Number(search.get('line'));
  const drafts = useDraftStore((state) => state.drafts);
  // Previews, shared globals and references see "mine" where conflict blocks remain in a draft.
  const shown = useMemo(() => previewDrafts(drafts), [drafts]);
  const sessions = useConflictStore((state) => state.sessions);
  const pausedForOtherTab = usePausedForOtherTab();
  const edit = useDraftStore((state) => state.edit);
  const discard = useDraftStore((state) => state.discard);
  const hydrated = useDraftStore((state) => state.hydrated);
  const saving = useSaveState((state) => state.locked);
  const sharedGlobals = useMemo<MarkupGlobals>(() => {
    const imports = tooltipImports(data?.bundle.tooltips ?? {}, shown, lang, data?.aliases ?? {});
    return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
  }, [data, shown, lang]);
  // One globals object per type, so renders that share a type share the object (and its parse).
  const typedGlobals = useMemo(() => {
    const cache = new Map<string | undefined, MarkupGlobals>();
    return (type: string | undefined) => {
      let globals = cache.get(type);
      if (!globals) cache.set(type, (globals = { ...sharedGlobals, type }));
      return globals;
    };
  }, [sharedGlobals]);
  const referenceSources = useMemo(
    () => tooltipTextSources(data?.bundle.tooltips ?? {}, shown, data?.aliases ?? {}),
    [data, shown],
  );
  // Saved text only, so the suggestion menu's usage counts do not change as you type.
  const usage = useMemo(() => corpusUsage(data?.bundle.tooltips ?? {}), [data?.bundle.tooltips]);
  const navigate = useNavigate();
  function openDefinition(target: TooltipTarget) {
    // Ordinary navigation (a pushed history entry), the same route a Globals page link takes.
    const canonical = data ? canonicalHash(target.hash, data) : target.hash;
    navigate(`/t/${canonical}?lang=${target.lang}&line=${target.line}&variant=${target.hash}`);
  }
  // With a left column beside the page (desktop shell) the preview, associations and history are
  // shown there; without one (a phone, or the page on its own) they stay inline in the page.
  const column = useShellColumn();
  const showPreview = column?.show;
  const reviewEntries = usePreviewReviewStore((state) => state.entries);
  // "Show preview" from the leave guard opens the column on a render that counts as seen: Base, or
  // Enhanced for an override with unseen edits. Compare never does, so it is left.
  const reveal = useRef<() => void>(undefined);
  useEffect(() => {
    if (!showPreview) return;
    return usePreviewReviewStore.getState().registerHost({
      show() {
        showPreview();
        reveal.current?.();
      },
    });
  }, [showPreview]);
  if (!data) return null;
  if (
    hashOverride === undefined &&
    (!parameter || !/^(0|[1-9]\d*)$/.test(parameter) || Number(parameter) > 0xffffffff)
  ) {
    return <h1>Invalid tooltip hash</h1>;
  }
  const hash = hashOverride ?? Number(parameter);
  const canonical = canonicalHash(hash, data);
  if (!readOnly && hash !== canonical)
    return <Navigate to={tooltipPath(canonical, search.toString())} replace />;
  const item = archivedItemFor(hash, data);
  if (!item && !data.bundle.tooltips[hash]) return <h1>Tooltip {hash} not found</h1>;
  const primaryBase = tooltipFor(hash, data);
  readOnly ||= hash > 3 && !data.items[hash] && !primaryBase.custom;
  const access = editorAccess({
    apiConfigured: Boolean(apiUrl),
    hydrated,
    saving,
    user,
    lang,
  });
  if (readOnly || (!item && hash > 3)) access.reason = 'Archived tooltip — read only';
  else if (pausedForOtherTab && !access.reason)
    access.reason = 'Paused: another tab changed your drafts. Answer the notice above.';

  // A phone's header row would grow for the pause sentence and push the text down; the status bar
  // (fixed height) already says it there.
  const pausedOnPhone = phone && pausedForOtherTab && access.reason?.startsWith('Paused:');
  const hosted = column !== null;
  const nameOf = (variant: number) => archivedItemFor(variant, data)?.name ?? `Tooltip ${variant}`;
  const legacyOf = (variant: number) =>
    data.categories.find((category) => category.id === archivedItemFor(variant, data)?.categoryId)
      ?.legacyType;
  const globalsFor = (variant: number): MarkupGlobals => typedGlobals(legacyOf(variant));
  const textOf = (variant: number) =>
    (drafts[variant]?.next ?? tooltipFor(variant, data)).text[lang]?.text ?? '';
  // What the preview renders: the same text with conflict blocks resolved to "mine".
  const previewTextOf = (variant: number) =>
    (shown[variant]?.next ?? tooltipFor(variant, data)).text[lang]?.text ?? '';
  /** The three versions an open conflict started from, for the editor's Compare view. */
  const conflictSourceOf = (variant: number): CompareData | undefined => {
    const session = sessions[variant];
    if (!session) return undefined;
    const theirs = session.head?.text[lang];
    return {
      mine: session.mine.text[lang]?.text ?? '',
      base: session.base ? (session.base.text[lang]?.text ?? '') : null,
      theirs: theirs?.text ?? '',
      theirsLabel: theirsLabel(theirs),
    };
  };

  // Enhanced versions: previewed next to the base; the ones with text of their own can be opened.
  const others = variantHashes(hash, data).filter((variant) => variant !== hash);
  const previewed = readOnly ? others : previewedVariants(hash, data);
  const overrides = readOnly ? [] : editableOverrides(hash, data);
  const storedForms =
    !readOnly && user?.role === 'maintainer' ? storedFormVariants(hash, data) : [];
  const requested = Number(search.get('variant'));
  const activeVariant =
    picked?.hash === hash ? picked.variant : overrides.includes(requested) ? requested : null;
  const activeHash = activeVariant ?? hash;
  const activeBase = tooltipFor(activeHash, data);
  const activeTooltip = drafts[activeHash]?.next ?? activeBase;
  const value = previewTextOf(hash);

  const enhancedViews: EnhancedView[] = previewed.map((variant) => {
    // Derived versions render the base text (drafts included) as their own type; overrides and
    // archived tooltips show the text they hold.
    const rendered = readOnly ? undefined : enhancedRender(hash, variant, lang, data, shown);
    return {
      hash: variant,
      name: nameOf(variant),
      text: rendered ? rendered.text : previewTextOf(variant),
      globals: globalsFor(variant),
      derived: rendered?.form === 'derived',
    };
  });
  const baseEntry = archivedItemFor(hash, data);
  const baseCategory = data.categories.find((candidate) => candidate.id === baseEntry?.categoryId);
  const pickedVariant = previewPick?.hash === hash ? previewPick.variant : undefined;
  const selectedView =
    enhancedViews.find((view) => view.hash === pickedVariant) ?? enhancedViews[0];
  const mode = effectiveMode(previewMode, phone, selectedView !== undefined);
  reveal.current = () => {
    const unseen = usePreviewReviewStore.getState().unreviewed(canonical);
    const override = enhancedViews.find((view) => !view.derived && unseen.includes(view.hash));
    if (override && !unseen.includes(hash)) {
      setPreviewPick({ hash, variant: override.hash });
      setPreviewMode('enhanced');
    } else setPreviewMode('base');
  };
  const previews = (
    <PreviewColumn
      hash={hash}
      lang={lang}
      name={nameOf(hash)}
      icon={baseEntry?.icon || undefined}
      categoryLabel={
        readOnly && baseEntry
          ? archiveCategoryLabel(baseEntry.categoryId, data)
          : (baseCategory?.label ?? baseEntry?.categoryId)
      }
      archiveIcon={readOnly}
      baseText={value}
      baseGlobals={globalsFor(hash)}
      enhanced={enhancedViews}
      mode={mode}
      onMode={setPreviewMode}
      variant={selectedView?.hash}
      onVariant={(variant) => setPreviewPick({ hash, variant })}
    />
  );
  // Reviewed means a Base or Enhanced render of the current text is on screen (never Compare).
  const seen = column
    ? previewedHashes(mode, hash, selectedView).map((variant) => (
        <PreviewAck key={variant} variant={variant} visible={!column.collapsed} />
      ))
    : null;

  const owner = singleOwnerLabel(hash, data);
  const shared = sharedPerkLabel(hash, data, compendiumSource);
  const rows = (
    <div className={styles.rows}>
      {!readOnly && (
        <>
          <ConflictRows hash={hash} lang={lang} onLanguage={changeLanguage} />
          {activeHash !== hash && (
            <ConflictRows hash={activeHash} lang={lang} onLanguage={changeLanguage} />
          )}
        </>
      )}
      {!readOnly && item && <AttachmentCategoryControl base={primaryBase} item={item} />}
      {owner && <NoteRow text={owner} />}
      {shared && <NoteRow text={shared} />}
      {!readOnly && <AssociationsPanel hash={activeHash} />}
      <HistoryPanel hash={activeHash} readOnly={readOnly} />
    </div>
  );

  // The editor's status bar tells how many edits the preview has not shown yet, and offers it.
  const previewStatus = column
    ? {
        unpreviewed: Object.values(reviewEntries).filter(
          (entry) => entry.canonical === canonical && entry.dirty > entry.reviewed,
        ).length,
        collapsed: column.collapsed,
        onShow: () => {
          const host = usePreviewReviewStore.getState().host;
          if (host) host.show();
          else column.show();
        },
      }
    : undefined;
  const translation = translationQueue([activeBase], [lang], data.aliases)[0];
  const overrideTargets = overrides.map((variant) => ({ hash: variant, name: nameOf(variant) }));
  const editing = (variant: number, base: Tooltip) => (
    <ClarityEditor
      key={`${variant}:${lang}`}
      value={textOf(variant)}
      lang={lang}
      globals={globalsFor(variant)}
      requireEnglish={hash > 3}
      readOnly={access.reason !== null}
      readOnlyReason={access.reason}
      preview={previewStatus}
      tooltipHash={variant}
      referenceSources={referenceSources}
      usage={usage}
      onOpenTooltip={openDefinition}
      // The translator toolbar stays until the markup row (a later step) replaces it.
      markupToolbar={lang !== 'en'}
      conflictSource={conflictSourceOf(variant)}
      highlightLine={variant === activeHash ? highlightLine : undefined}
      onChange={(text) => edit(base, lang, text, user?.login ?? 'local draft')}
    />
  );

  const header = (
    <EditorPaneHeader
      lang={lang}
      onLanguage={changeLanguage}
      draft={!readOnly && Boolean(drafts[activeHash])}
      saving={saving}
      onDiscard={() => discard(activeHash)}
      reason={pausedOnPhone ? null : access.reason}
      switchTo={access.switchTo}
      onSwitch={changeLanguage}
      details={
        <LanguageSummary
          base={activeBase}
          lang={lang}
          draft={activeTooltip.text[lang]?.text !== activeBase.text[lang]?.text}
          plain
        />
      }
      overrides={overrideTargets}
      activeOverride={
        activeVariant === null ? undefined : { hash: activeVariant, name: nameOf(activeVariant) }
      }
      onEditOverride={(variant) => setPicked({ hash, variant })}
      onBack={() => setPicked({ hash, variant: null })}
      storedForms={storedForms.map((variant) => ({
        target: { hash: variant, name: nameOf(variant) },
        node: (
          <ClarityEditor
            value={tooltipFor(variant, data).text[lang]?.text ?? ''}
            lang={lang}
            globals={globalsFor(variant)}
            requireEnglish={false}
            readOnly
            readOnlyReason="Stored form: read only"
            onChange={() => undefined}
          />
        ),
      }))}
    />
  );

  return (
    <article className={styles.page}>
      <h1 className={styles.srOnly}>{nameOf(hash)}</h1>
      <VariantWorkspace
        header={header}
        initialPanel={readOnly ? 'preview' : undefined}
        source={
          lang === 'en' ? undefined : (
            <TranslationSource
              key={`${activeHash}:${lang}`}
              text={activeTooltip.text.en?.text}
              diff={
                translation?.state === 'outdated' && translation.sourceUpdatedAt
                  ? {
                      hash: activeHash,
                      sourceUpdatedAt: translation.sourceUpdatedAt,
                      current: activeBase.text.en?.text ?? '',
                    }
                  : undefined
              }
            />
          )
        }
        editor={
          <section
            aria-label={`${nameOf(hash)} editor (${languageLabel(lang)})`}
            className={styles.editorSection}
          >
            {/* The base editor stays mounted while an override is open: caret and undo survive. */}
            <div className={styles.editorSlot} hidden={activeVariant !== null}>
              {editing(hash, primaryBase)}
            </div>
            {activeVariant !== null && (
              <div className={styles.editorSlot}>
                {editing(activeVariant, tooltipFor(activeVariant, data))}
              </div>
            )}
          </section>
        }
        preview={
          hosted ? null : (
            <div className={styles.inlinePreview}>
              {previews}
              {rows}
            </div>
          )
        }
        compendium={
          !readOnly && user?.role !== 'translator' ? <CompendiumPanel base={activeBase} /> : null
        }
      />
      {hosted && (
        <ShellSlot name="left">
          <div className={styles.leftStack}>
            <div className={styles.previewBody}>
              {previews}
              {seen}
            </div>
            {rows}
          </div>
        </ShellSlot>
      )}
    </article>
  );
}

/** One line of context under the preview; the full text is the tooltip. */
function NoteRow({ text }: { text: string }) {
  return <PanelRow label={<span title={text}>{text}</span>} className={styles.noteRow} />;
}

/** Records that the preview shows this variant's current text, while the preview is visible. */
function PreviewAck({ variant, visible }: { variant: number; visible: boolean }) {
  useAcknowledgePreview(variant, visible);
  return null;
}
