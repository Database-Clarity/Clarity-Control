import { ArchiveIcon } from '../archive/ArchiveIcon';
import { languageLabel } from '../../languageLabels';
import { memo, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  LivePreviewIdentity,
  previewIdentityFor,
  type PreviewIdentity,
} from './LivePreviewIdentity';
import { useSteppingActivity } from '../navigation/steppingActivity';
import { nameWidthEm } from './nameFit';
import { Link } from 'react-router-dom';
import {
  markupLanguage,
  parseMarkup,
  type Lang,
  type MarkupGlobals,
  resolveAlias,
} from '@clarity/core';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { canonicalHash, classifiedCategory, itemFor, tooltipFor } from '../navigation/catalog';
import styles from './TooltipPreview.module.scss';
import { Lines } from './MarkupRenderer';
export { classNames, Lines, PreviewSpan } from './MarkupRenderer';

export interface TooltipPreviewProps {
  text: string;
  lang: Lang;
  name: string;
  /** Exotic armour: the piece carrying this perk, shown above the perk's name. */
  piece?: string;
  icon?: string;
  categoryLabel?: string;
  globals: MarkupGlobals;
  tooltipHash?: number;
  archiveIcon?: boolean;
  /** Content between the perk header and the description (the column's version switch). */
  bar?: ReactNode;
  /** The column variant: header and bar span the whole column and stay put while the body scrolls. */
  fill?: boolean;
  /** Replaces the rendered description (the column's Compare view); markup issues are hidden. */
  children?: ReactNode;
}

/** A bare rendering of markup (no header), for popovers; same renderer and styles as the preview. */
export function MarkupSnippet({
  text,
  lang,
  globals,
}: {
  text: string;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const parsed = useMemo(() => parseMarkup(text, globals), [text, globals]);
  return (
    <div className={styles.snippet} lang={markupLanguage(lang)}>
      <Lines lines={parsed.lines} />
    </div>
  );
}

export function TooltipPreview({
  text,
  lang,
  name,
  piece,
  icon,
  categoryLabel,
  globals,
  tooltipHash,
  archiveIcon = false,
  bar,
  fill = false,
  children,
}: TooltipPreviewProps) {
  const replaced = Boolean(children);
  // Compare supplies its already-rendered body and hides these diagnostics. Do not
  // parse the base a third time only to discard that result on every keystroke.
  const parsed = useMemo(
    () => (replaced ? null : parseMarkup(text, globals)),
    [text, globals, replaced],
  );
  return (
    <section
      className={[styles.preview, fill ? styles.fill : ''].filter(Boolean).join(' ')}
      lang={markupLanguage(lang)}
      aria-label={`${name} preview`}
    >
      <div className={styles.top}>
        <PreviewHeader
          name={name}
          piece={piece}
          icon={icon}
          categoryLabel={categoryLabel}
          archiveIcon={archiveIcon}
          live={fill}
        />
        {bar}
      </div>
      <div className={styles.description}>{children ?? <Lines lines={parsed?.lines ?? []} />}</div>
      {!children && parsed && parsed.diagnostics.length > 0 && (
        <details className={styles.diagnostics}>
          <summary>{parsed.diagnostics.length} markup issue(s)</summary>
          <ul>
            {parsed.diagnostics.map((issue, index) => (
              <li key={index}>
                {issue.severity}: {issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {tooltipHash !== undefined && (
        <AssociatedTooltips hash={tooltipHash} lang={lang} globals={globals} />
      )}
    </section>
  );
}

function PreviewHeader(props: PreviewIdentity & { live: boolean }) {
  const identity = useContext(LivePreviewIdentity);
  const target = useSteppingActivity((state) => (props.live ? state.target : undefined));
  const data = useDataStore((state) => (target ? state.data : null));
  const urgent = useMemo(
    () =>
      target && data
        ? previewIdentityFor(
            canonicalHash(Number(target.split('/')[2].split('?')[0]), data),
            data,
            identity?.archiveIcon,
          )
        : undefined,
    [target, data, identity?.archiveIcon],
  );
  const { name, piece, icon, categoryLabel, archiveIcon } =
    urgent || (props.live && identity) || props;
  const iconUrl = icon?.startsWith('/common/') ? `https://www.bungie.net${icon}` : icon;
  return (
    <header className={styles.header}>
      {archiveIcon ? (
        <ArchiveIcon icon={icon} />
      ) : (
        iconUrl && linkUrl(iconUrl) && <img className={styles.icon} src={iconUrl} alt="" />
      )}
      <div className={styles.identity}>
        {piece !== undefined && (
          // An empty piece row still holds its line (exotic armour named after its piece).
          <div
            className={styles.piece}
            title={piece || undefined}
            aria-hidden={!piece || undefined}
          >
            {piece}
          </div>
        )}
        <div
          className={styles.name}
          title={name}
          style={{ '--name-em': nameWidthEm(name) } as CSSProperties}
        >
          {name}
        </div>
        {categoryLabel && (
          <div className={styles.category} title={categoryLabel}>
            {categoryLabel}
          </div>
        )}
      </div>
    </header>
  );
}

function AssociatedTooltips({
  hash,
  lang,
  globals,
}: {
  hash: number;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const data = useDataStore((state) => state.data);
  const membership = useDraftStore(
    (state) => (state.drafts[hash]?.next ?? data?.bundle.tooltips[hash])?.associated,
  );
  const associated = useMemo(
    () =>
      data
        ? [
            ...new Set((membership ?? []).map((target) => resolveAlias(target, data.aliases))),
          ].filter((target) => target !== hash)
        : [],
    [membership, hash, data],
  );
  if (!data) return null;
  if (!associated.length) return null;
  return (
    <section className={styles.associated} aria-label="Associated tooltip previews">
      {associated.map((target) => (
        <AssociatedTooltip key={target} target={target} data={data} lang={lang} globals={globals} />
      ))}
    </section>
  );
}

const AssociatedTooltip = memo(function AssociatedTooltip({
  target,
  data,
  lang,
  globals,
}: {
  target: number;
  data: EditorData;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const text = useDraftStore(
    (state) => (state.drafts[target]?.next ?? tooltipFor(target, data)).text[lang]?.text,
  );
  const item = itemFor(target, data);
  const name = item?.name ?? `Tooltip ${target}`;
  const category = data.categories.find((entry) => entry.id === item?.categoryId);
  const typed = useMemo(
    () => ({ ...globals, type: category?.legacyType }),
    [globals, category?.legacyType],
  );
  return (
    <details>
      <summary>
        {item?.icon && <img src={`https://www.bungie.net${item.icon}`} alt="" />}
        <Link to={`/t/${canonicalHash(target, data)}`}>{name}</Link>
      </summary>
      {text !== undefined ? (
        <TooltipPreview
          text={text}
          lang={lang}
          name={name}
          icon={item?.icon}
          categoryLabel={classifiedCategory(item, data)?.label}
          globals={typed}
        />
      ) : (
        <p>No {languageLabel(lang)} text yet.</p>
      )}
    </details>
  );
});
