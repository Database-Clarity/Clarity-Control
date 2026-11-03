import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { AttachmentCategoryControl } from './AttachmentCategoryControl';
import { useCompendiumStore } from '../compendium/store';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { translationQueue, type Lang, type MarkupGlobals, type Tooltip } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { tooltipImports } from '../../services/tooltipImports';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
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
import { useAcknowledgePreview } from '../navigation/useAcknowledgePreview';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { ClarityEditor } from '../editor';
import { tooltipTextSources } from '../editor/references';
import type { TooltipTarget } from '../editor/referenceActions';
import { TooltipPreview } from '../preview';
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
import { editableOverrides, previewedVariants, storedFormVariants, variantForm } from './variants';
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
  const user = useAuthStore((state) => state.user);
  const lang = defaultLanguage(user, search, remembered);
  function changeLanguage(next: Lang) {
    setRemembered(next);
    setSearch(withLanguage(search, next));
  }
  const highlightLine = Number(search.get('line'));
  const drafts = useDraftStore((state) => state.drafts);
  const edit = useDraftStore((state) => state.edit);
  const discard = useDraftStore((state) => state.discard);
  const hydrated = useDraftStore((state) => state.hydrated);
  const saving = useSaveState((state) => state.locked);
  const sharedGlobals = useMemo<MarkupGlobals>(() => {
    const imports = tooltipImports(data?.bundle.tooltips ?? {}, drafts, lang, data?.aliases ?? {});
    return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
  }, [data, drafts, lang]);
  const referenceSources = useMemo(
    () => tooltipTextSources(data?.bundle.tooltips ?? {}, drafts, data?.aliases ?? {}),
    [data, drafts],
  );
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
  useEffect(() => {
    if (!showPreview) return;
    return usePreviewReviewStore.getState().registerHost({ show: showPreview });
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

  const hosted = column !== null;
  const nameOf = (variant: number) => archivedItemFor(variant, data)?.name ?? `Tooltip ${variant}`;
  const legacyOf = (variant: number) =>
    data.categories.find((category) => category.id === archivedItemFor(variant, data)?.categoryId)
      ?.legacyType;
  const globalsFor = (variant: number): MarkupGlobals => ({
    ...sharedGlobals,
    type: legacyOf(variant),
  });
  const textOf = (variant: number) =>
    (drafts[variant]?.next ?? tooltipFor(variant, data)).text[lang]?.text ?? '';

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
  const value = textOf(hash);

  const previews = [hash, ...previewed].map((variant) => {
    const entry = archivedItemFor(variant, data);
    const entryCategory = data.categories.find((candidate) => candidate.id === entry?.categoryId);
    const derived = variant !== hash && !readOnly && variantForm(hash, variant, data) === 'derived';
    return (
      <section
        key={variant}
        className={styles.previewItem}
        aria-label={`${nameOf(variant)} preview`}
      >
        {previewed.length > 0 && variant !== hash && (
          <h2 className={styles.previewTitle}>{nameOf(variant)} (enhanced version)</h2>
        )}
        <TooltipPreview
          text={derived ? value : textOf(variant)}
          lang={lang}
          name={nameOf(variant)}
          icon={entry?.icon || undefined}
          categoryLabel={
            readOnly && entry
              ? archiveCategoryLabel(entry.categoryId, data)
              : (entryCategory?.label ?? entry?.categoryId)
          }
          globals={globalsFor(variant)}
          archiveIcon={readOnly}
          tooltipHash={variant}
        />
        {column && <PreviewAck variant={variant} visible={!column.collapsed} />}
      </section>
    );
  });

  const owner = singleOwnerLabel(hash, data);
  const shared = sharedPerkLabel(hash, data, compendiumSource);
  const rows = (
    <div className={styles.rows}>
      {!readOnly && item && <AttachmentCategoryControl base={primaryBase} item={item} />}
      {owner && <NoteRow text={owner} />}
      {shared && <NoteRow text={shared} />}
      {!readOnly && <AssociationsPanel hash={activeHash} />}
      <HistoryPanel hash={activeHash} readOnly={readOnly} />
    </div>
  );

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
      tooltipHash={variant}
      referenceSources={referenceSources}
      onOpenTooltip={openDefinition}
      // The translator toolbar stays until the markup row (a later step) replaces it.
      markupToolbar={lang !== 'en'}
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
      reason={access.reason}
      switchTo={access.switchTo}
      onSwitch={changeLanguage}
      details={
        <LanguageSummary
          base={activeBase}
          lang={lang}
          draft={activeTooltip.text[lang]?.text !== activeBase.text[lang]?.text}
          open
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
            <div className={styles.previewBody}>{previews}</div>
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
