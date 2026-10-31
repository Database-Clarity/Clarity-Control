import { useMemo, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { languages, langSchema, type Lang, type MarkupGlobals } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { tooltipImports } from '../../services/tooltipImports';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import {
  canonicalHash,
  itemFor,
  sharedPerkLabel,
  tooltipFor,
  variantHashes,
  weaponTypesFor,
} from '../navigation/catalog';
import { ClarityEditor } from '../editor';
import { TooltipPreview } from '../preview';
import { HistoryPanel } from '../history/HistoryPanel';
import { canEditLanguage } from '../auth/permissions';
import { useSaveState } from '../../services/save/state';
import { AssociationsPanel } from '../associations/AssociationsPanel';
import styles from './TooltipPage.module.scss';

export function TooltipPage() {
  const { hash: parameter } = useParams();
  const [search, setSearch] = useSearchParams();
  const data = useDataStore((state) => state.data);
  const [defaultLang, setLang] = useState<Lang>('en');
  const lang = langSchema.safeParse(search.get('lang')).data ?? defaultLang;
  const highlightLine = Number(search.get('line'));
  const drafts = useDraftStore((state) => state.drafts);
  const edit = useDraftStore((state) => state.edit);
  const discard = useDraftStore((state) => state.discard);
  const hydrated = useDraftStore((state) => state.hydrated);
  const user = useAuthStore((state) => state.user);
  const saving = useSaveState((state) => state.locked);
  const sharedGlobals = useMemo<MarkupGlobals>(() => {
    const imports = tooltipImports(data?.bundle.tooltips ?? {}, drafts, lang, data?.aliases ?? {});
    return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
  }, [data, drafts, lang]);
  if (!data) return null;
  if (!parameter || !/^(0|[1-9]\d*)$/.test(parameter) || Number(parameter) > 0xffffffff) {
    return <h1>Invalid tooltip hash</h1>;
  }
  const hash = Number(parameter);
  const canonical = canonicalHash(hash, data);
  if (hash !== canonical) return <Navigate to={`/t/${canonical}`} replace />;
  const item = itemFor(hash, data);
  if (!item && !data.bundle.tooltips[hash]) return <h1>Tooltip {hash} not found</h1>;
  return (
    <article>
      <header className={styles.header}>
        {item?.icon && <img src={`https://www.bungie.net${item.icon}`} alt="" />}
        <div>
          <h1>{item?.name ?? `Tooltip ${hash}`}</h1>
          <p>
            {data.categories.find((category) => category.id === item?.categoryId)?.label ??
              item?.categoryId}{' '}
            / {hash}
          </p>
          {sharedPerkLabel(hash, data) && <p role="note">{sharedPerkLabel(hash, data)}</p>}
        </div>
        <label>
          Language{' '}
          <select
            value={lang}
            onChange={(event) => {
              setLang(langSchema.parse(event.target.value));
              setSearch({ lang: event.target.value });
            }}
          >
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </label>
      </header>
      {variantHashes(hash, data).map((variant) => {
        const base = tooltipFor(variant, data);
        const tooltip = drafts[variant]?.next ?? base;
        const entry = itemFor(variant, data);
        const category = data.categories.find((category) => category.id === entry?.categoryId);
        const globals: MarkupGlobals = { ...sharedGlobals, type: category?.legacyType };
        const value = tooltip.text[lang]?.text ?? '';
        return (
          <section key={variant} className={styles.variant}>
            <header>
              <h2>
                {entry?.name ?? `Tooltip ${variant}`} {variant !== hash && '(enhanced variant)'}
              </h2>
              <small>{variant}</small>
              {drafts[variant] && (
                <button type="button" disabled={saving} onClick={() => discard(variant)}>
                  Discard this tooltip's draft
                </button>
              )}
            </header>
            <div className={styles.columns}>
              <section aria-label={`${entry?.name ?? variant} editor (${lang})`}>
                <h3>Clarity text ({lang})</h3>
                <ClarityEditor
                  key={`${variant}:${lang}`}
                  value={value}
                  lang={lang}
                  globals={globals}
                  requireEnglish={variant > 3}
                  readOnly={!apiUrl || !hydrated || saving || !canEditLanguage(user, lang)}
                  highlightLine={
                    Number(search.get('variant') ?? hash) === variant ? highlightLine : undefined
                  }
                  onChange={(text) => edit(base, lang, text, user?.login ?? 'local draft')}
                />
              </section>
              <TooltipPreview
                text={value}
                lang={lang}
                name={entry?.name ?? `Tooltip ${variant}`}
                icon={entry?.icon || undefined}
                categoryLabel={category?.label ?? entry?.categoryId}
                globals={globals}
                tooltipHash={variant}
                weaponTypes={weaponTypesFor(variant, data)}
                weaponTypeLabels={data.weaponTypeLabels}
              />
            </div>
            <AssociationsPanel hash={variant} />
            <HistoryPanel hash={variant} />
          </section>
        );
      })}
    </article>
  );
}
