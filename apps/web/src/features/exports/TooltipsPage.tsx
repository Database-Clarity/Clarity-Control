import { SkeletonBoundary } from '../../ui/Skeleton';
// Partners' read-only "Tooltips" view (spec section 8): a finder and the preview pane on the
// published data (the snapshot the data site was built from), with no editor, drafts, or
// Compendium. The pick lives in the URL (`?hash=`), so Back returns to the previous tooltip.
import { languages, type Lang, type MarkupGlobals } from '@clarity/core';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { languageLabel } from '../../languageLabels';
import { useDataStore } from '../../stores/data';
import { When } from '../../ui/When';
import { classifiedCategory, editorName, itemFor, previewPiece } from '../navigation/catalog';
import { TooltipPreview } from '../preview';
import type { Published } from './previewCore';
import { recentPicks, rememberPick, TooltipSearch, type Pick } from './TooltipSearch';
import { usePreview, useSiteRefresh, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

export function TooltipsPage() {
  useSiteRefresh();
  const preview = usePreview();
  const status = useSiteStore((site) => site.status);
  const siteError = useSiteStore((site) => site.error);
  const data = useDataStore((store) => store.data);
  const [params, setParams] = useSearchParams();
  const [recent, setRecent] = useState(() => recentPicks('tooltips'));
  const lang = (languages as readonly string[]).includes(params.get('lang') ?? '')
    ? (params.get('lang') as Lang)
    : 'en';
  const hash = params.get('hash') ?? recent[0]?.hash ?? null;
  const [published, setPublished] = useState<{ lang: Lang; value: Published } | null>(null);
  const client = preview.state.kind === 'ready' ? preview.state.client : null;
  useEffect(() => {
    if (!client) return;
    let live = true;
    client.published(lang).then((value) => live && setPublished({ lang, value }));
    return () => {
      live = false;
    };
  }, [client, lang]);
  const globals = useMemo<MarkupGlobals | null>(
    () =>
      published && published.lang === lang
        ? {
            variables: published.value.variables,
            titles: published.value.titles,
            imports: published.value.texts,
          }
        : null,
    [published, lang],
  );
  const choose = (pick: Pick) => {
    setRecent(rememberPick('tooltips', pick));
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('hash', pick.hash);
      return next;
    });
  };
  const item = data && hash ? itemFor(Number(hash), data) : undefined;
  const text = hash && globals ? (published?.value.texts[hash] ?? null) : null;
  // The row's own semantic type, as the export engine renders it (enhanced parts and the like).
  const typed = useMemo(
    () => (globals && hash ? { ...globals, type: published?.value.types[hash] } : globals),
    [globals, hash, published],
  );

  return (
    <section className={styles.tooltipsPage} aria-labelledby="tooltips-title">
      <div className={styles.listHeader}>
        <h1 id="tooltips-title" className={styles.pageTitle}>
          Tooltips
        </h1>
        <span className={styles.meta}>
          Published data
          {status && (
            <>
              {' · built '}
              <When value={status.builtAt} nowrap />
            </>
          )}
        </span>
        <label className={styles.inlineLabel}>
          <span className={styles.visuallyHidden}>Language</span>
          <select
            className={styles.select}
            value={lang}
            onChange={(event) =>
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (event.target.value === 'en') next.delete('lang');
                  else next.set('lang', event.target.value);
                  return next;
                },
                { replace: true },
              )
            }
          >
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.tooltipsBody}>
        <div className={styles.tooltipsFinder}>
          <TooltipSearch onPick={choose} recent={recent} />
        </div>
        <div className={styles.tooltipsPreview}>
          {preview.newer && (
            <p className={styles.banner} data-tone="warn" role="status">
              A newer build is out.{' '}
              <button type="button" className={styles.linkButton} onClick={preview.adopt}>
                Reload
              </button>
            </p>
          )}
          {siteError && !client && (
            <p role="alert" className={styles.badText}>
              The data site cannot be read: {siteError}
            </p>
          )}
          {preview.state.kind === 'error' && (
            <p role="alert" className={styles.badText}>
              The published data cannot load: {preview.state.message}
            </p>
          )}

          <SkeletonBoundary
            pending={!globals}
            error={!!siteError || preview.state.kind === 'error'}
            identity={hash}
            label="Loading the published data…"
          >
            {globals && !hash && (
              <p className={styles.meta}>Find a tooltip to see it as it was published.</p>
            )}
            {globals && hash && text === null && (
              <p className={styles.meta}>Hash {hash} is not in the published data.</p>
            )}
            {globals && hash && text !== null && (
              <TooltipPreview
                text={text}
                lang={lang}
                name={item ? editorName(item) : `Hash ${hash}`}
                piece={item ? previewPiece(item) : undefined}
                icon={item?.icon}
                categoryLabel={item && data ? classifiedCategory(item, data)?.label : undefined}
                globals={typed!}
              />
            )}
          </SkeletonBoundary>
        </div>
      </div>
    </section>
  );
}
