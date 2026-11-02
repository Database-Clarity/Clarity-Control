import { ArchiveIcon } from '../archive/ArchiveIcon';
import { languageLabel } from '../../languageLabels';
import { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  markupLanguage,
  parseMarkup,
  type Lang,
  type MarkupGlobals,
  type MarkupLine,
  type MarkupSpan,
  resolveAlias,
} from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { canonicalHash, itemFor, tooltipFor } from '../navigation/catalog';
import styles from './TooltipPreview.module.scss';

export interface TooltipPreviewProps {
  text: string;
  lang: Lang;
  name: string;
  icon?: string;
  categoryLabel?: string;
  globals: MarkupGlobals;
  tooltipHash?: number;
  archiveIcon?: boolean;
}

function classNames(names?: (string | undefined)[]) {
  return names?.flatMap((name) => (name && styles[name] ? [styles[name]] : [])).join(' ');
}

function linkUrl(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : undefined;
}

function Content({ part }: { part: MarkupSpan }) {
  const id = useId();
  const link = part.link ? linkUrl(part.link) : undefined;
  return (
    <span className={classNames(part.classNames)}>
      {part.title ? (
        <span className={styles.titleAnchor} tabIndex={0} aria-describedby={id}>
          {part.text}
          <span className={styles.titleContainer} role="tooltip" id={id}>
            <Lines lines={part.title} />
          </span>
        </span>
      ) : link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {part.text}
        </a>
      ) : (
        <span title={part.link ? 'Unsafe link omitted' : undefined}>{part.text}</span>
      )}
    </span>
  );
}

function Lines({ lines }: { lines: MarkupLine[] }) {
  return (
    <>
      {lines.map((line, index) => {
        return line.table ? (
          <table className={classNames(line.classNames)} key={index}>
            <tbody>
              {line.table.map((row, rowIndex) => (
                <tr key={rowIndex} className={classNames(row.classNames)}>
                  {row.rowContent?.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      colSpan={cell.colSpan}
                      rowSpan={cell.rowSpan}
                      className={classNames(cell.classNames)}
                    >
                      {cell.cellContent.map((part, partIndex) => (
                        <Content key={partIndex} part={part} />
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div key={index} className={classNames(line.classNames)}>
            {line.linesContent?.map((part, partIndex) => (
              <Content key={partIndex} part={part} />
            ))}
          </div>
        );
      })}
    </>
  );
}

export function TooltipPreview({
  text,
  lang,
  name,
  icon,
  categoryLabel,
  globals,
  tooltipHash,
  archiveIcon = false,
}: TooltipPreviewProps) {
  const parsed = useMemo(() => parseMarkup(text, globals), [text, globals]);
  const iconUrl = icon?.startsWith('/common/') ? `https://www.bungie.net${icon}` : icon;
  return (
    <section className={styles.preview} lang={markupLanguage(lang)} aria-label={`${name} preview`}>
      <header className={styles.header}>
        {archiveIcon ? (
          <ArchiveIcon icon={icon} />
        ) : (
          iconUrl && linkUrl(iconUrl) && <img className={styles.icon} src={iconUrl} alt="" />
        )}
        <div>
          <div className={styles.name}>{name}</div>
          {categoryLabel && <div className={styles.category}>{categoryLabel}</div>}
        </div>
      </header>
      <div className={styles.description}>
        <Lines lines={parsed.lines} />
      </div>
      {parsed.diagnostics.length > 0 && (
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
  const drafts = useDraftStore((state) => state.drafts);
  if (!data) return null;
  const tooltip = drafts[hash]?.next ?? tooltipFor(hash, data);
  const associated = [
    ...new Set(tooltip.associated.map((target) => resolveAlias(target, data.aliases))),
  ].filter((target) => target !== hash);
  if (!associated.length) return null;
  return (
    <section className={styles.associated} aria-label="Associated tooltip previews">
      {associated.map((target) => {
        const item = itemFor(target, data);
        const next = drafts[target]?.next ?? tooltipFor(target, data);
        const name = item?.name ?? `Tooltip ${target}`;
        const category = data.categories.find((entry) => entry.id === item?.categoryId);
        return (
          <details key={target}>
            <summary>
              {item?.icon && <img src={`https://www.bungie.net${item.icon}`} alt="" />}
              <Link to={`/t/${canonicalHash(target, data)}`}>{name}</Link>
            </summary>
            {next.text[lang] ? (
              <TooltipPreview
                text={next.text[lang].text}
                lang={lang}
                name={name}
                icon={item?.icon}
                categoryLabel={category?.label}
                globals={{ ...globals, type: category?.legacyType }}
              />
            ) : (
              <p>No {languageLabel(lang)} text yet.</p>
            )}
          </details>
        );
      })}
    </section>
  );
}
