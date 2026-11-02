import { ArchiveIcon } from '../archive/ArchiveIcon';
import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { AttachmentCategoryControl } from './AttachmentCategoryControl';
import { classifyItem, categoryLabel } from '../compendium/itemClassification';
import { useCompendiumStore } from '../compendium/store';
import { languageLabel } from '../../languageLabels';
import { useMemo, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  languages,
  langSchema,
  translationQueue,
  type Lang,
  type MarkupGlobals,
} from '@clarity/core';
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
import { ClarityEditor } from '../editor';
import { TooltipPreview } from '../preview';
import { HistoryPanel } from '../history/HistoryPanel';
import { useSaveState } from '../../services/save/state';
import { AssociationsPanel } from '../associations/AssociationsPanel';
import { editorAccess } from './access';
import { defaultLanguage, withLanguage } from './language';
import { LanguageSummary } from './LanguageSummary';
import { TranslationSource } from './TranslationSource';
import { VariantWorkspace } from './VariantWorkspace';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import styles from './TooltipPage.module.scss';

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
  const primaryTooltip = drafts[hash]?.next ?? primaryBase;
  const primaryAccess = editorAccess({
    apiConfigured: Boolean(apiUrl),
    hydrated,
    saving,
    user,
    lang,
  });
  if (readOnly || (!item && hash > 3)) primaryAccess.reason = 'Archived tooltip — read only';
  const primarySwitchTo = primaryAccess.switchTo;
  const effectiveCategory =
    item && (classifyItem(item, primaryTooltip)?.categoryId ?? item.categoryId);
  return (
    <article>
      <header className={styles.header}>
        {readOnly ? (
          <ArchiveIcon icon={item?.icon} />
        ) : (
          item?.icon && <img src={`https://www.bungie.net${item.icon}`} alt="" />
        )}
        <div className={styles.identityText}>
          <h1>{item?.name ?? `Tooltip ${hash}`}</h1>
          <p>
            {readOnly
              ? archiveCategoryLabel(effectiveCategory ?? 'unknown', data)
              : (categoryLabel(effectiveCategory ?? '') ??
                data.categories.find((category) => category.id === effectiveCategory)?.label ??
                effectiveCategory)}{' '}
            / {hash}
          </p>
          {!readOnly && item && <AttachmentCategoryControl base={primaryBase} item={item} />}
          {singleOwnerLabel(hash, data) && (
            <p role="note" className={styles.identityOwner}>
              {singleOwnerLabel(hash, data)}
            </p>
          )}
          {sharedPerkLabel(hash, data, compendiumSource) && (
            <p role="note" className={styles.identityOwner}>
              {sharedPerkLabel(hash, data, compendiumSource)}
            </p>
          )}
        </div>
        <label>
          <span className={styles.languageLabel}>Language</span>{' '}
          <select
            aria-label="Language"
            value={lang}
            onChange={(event) => changeLanguage(langSchema.parse(event.target.value))}
          >
            {languages.map((language) => (
              <option key={language} value={language}>
                {languageLabel(language)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.phoneMeta}>
          <div>
            <LanguageSummary
              base={primaryBase}
              lang={lang}
              draft={primaryTooltip.text[lang]?.text !== primaryBase.text[lang]?.text}
            />
          </div>
          {primaryAccess.reason && !readOnly && (
            <details>
              <summary>Read-only details</summary>
              <p role="status" className={styles.reason}>
                {primaryAccess.reason}
                {primarySwitchTo && (
                  <>
                    {' '}
                    <button type="button" onClick={() => changeLanguage(primarySwitchTo)}>
                      Switch to {languageLabel(primarySwitchTo)}
                    </button>
                  </>
                )}
              </p>
            </details>
          )}
        </div>
      </header>
      {readOnly && (
        <p role="status" className={styles.archivedNotice}>
          {primaryAccess.reason}
        </p>
      )}
      {variantHashes(hash, data).map((variant) => {
        const base = tooltipFor(variant, data);
        const tooltip = drafts[variant]?.next ?? base;
        const entry = archivedItemFor(variant, data);
        const category = data.categories.find((category) => category.id === entry?.categoryId);
        const globals: MarkupGlobals = { ...sharedGlobals, type: category?.legacyType };
        const value = tooltip.text[lang]?.text ?? '';
        const translation = translationQueue([base], [lang], data.aliases)[0];
        const panels = (
          <>
            {!readOnly && <AssociationsPanel hash={variant} />}
            <HistoryPanel hash={variant} readOnly={readOnly} />
          </>
        );
        return (
          <section key={variant} className={styles.variant}>
            <header className={variant === hash ? styles.primaryVariant : undefined}>
              <h2>
                {entry?.name ?? `Tooltip ${variant}`} {variant !== hash && '(enhanced variant)'}
              </h2>
              <small>{variant}</small>
              {!readOnly && drafts[variant] && (
                <button type="button" disabled={saving} onClick={() => discard(variant)}>
                  Discard this tooltip's draft
                </button>
              )}
            </header>
            <VariantWorkspace
              initialPanel={readOnly ? 'preview' : undefined}
              source={
                lang === 'en' ? undefined : (
                  <TranslationSource
                    key={`${variant}:${lang}`}
                    text={tooltip.text.en?.text}
                    diff={
                      translation?.state === 'outdated' && translation.sourceUpdatedAt
                        ? {
                            hash: variant,
                            sourceUpdatedAt: translation.sourceUpdatedAt,
                            current: base.text.en?.text ?? '',
                          }
                        : undefined
                    }
                  />
                )
              }
              editor={
                <section aria-label={`${entry?.name ?? variant} editor (${languageLabel(lang)})`}>
                  <h3 className={styles.editorTitle}>Clarity text ({languageLabel(lang)})</h3>
                  <div className={variant === hash ? styles.primaryMetadata : undefined}>
                    <LanguageSummary
                      base={base}
                      lang={lang}
                      draft={tooltip.text[lang]?.text !== base.text[lang]?.text}
                    />
                    {primaryAccess.reason && !readOnly && (
                      <p role="status" className={styles.reason}>
                        {primaryAccess.reason}
                        {primarySwitchTo && (
                          <>
                            {' '}
                            <button type="button" onClick={() => changeLanguage(primarySwitchTo)}>
                              Switch to {languageLabel(primarySwitchTo)}
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  <ClarityEditor
                    key={`${variant}:${lang}`}
                    value={value}
                    lang={lang}
                    globals={globals}
                    requireEnglish={variant > 3}
                    readOnly={primaryAccess.reason !== null}
                    markupToolbar={lang !== 'en'}
                    highlightLine={
                      Number(search.get('variant') ?? hash) === variant ? highlightLine : undefined
                    }
                    onChange={(text) => edit(base, lang, text, user?.login ?? 'local draft')}
                  />
                </section>
              }
              preview={
                <div>
                  <TooltipPreview
                    text={value}
                    lang={lang}
                    name={entry?.name ?? `Tooltip ${variant}`}
                    icon={entry?.icon || undefined}
                    categoryLabel={
                      readOnly && entry
                        ? archiveCategoryLabel(entry.categoryId, data)
                        : (category?.label ?? entry?.categoryId)
                    }
                    globals={globals}
                    archiveIcon={readOnly}
                    tooltipHash={variant}
                  />
                  {!readOnly && user?.role !== 'translator' && <CompendiumPanel base={base} />}
                </div>
              }
            />
            {user?.role === 'translator' ? (
              <details className={styles.more}>
                <summary>Associations and history</summary>
                {panels}
              </details>
            ) : (
              panels
            )}
          </section>
        );
      })}
    </article>
  );
}
