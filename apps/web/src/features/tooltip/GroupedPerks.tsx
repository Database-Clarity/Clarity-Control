import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import { applyInactiveMoves, useDataStore } from '../../stores/data';
import {
  loadSandboxPerkText,
  sandboxPerkName,
  sandboxPerkTextFailed,
  useSandboxPerkText,
} from '../manifest/manifestText';
import { GroupRemoveControl } from './GroupRemoveControl';
import { InactiveMoveControl } from './InactiveMoveControl';
import { entryView, type EntryRow, type GroupedPerk } from './grouping';
import pageStyles from './TooltipPage.module.scss';
import styles from './GroupedPerks.module.scss';

export const groupedLabel = 'Items and perk effects';
export const groupedTitle = 'Which items and perk effects share this text (maintainers)';

/** The maintainers' list: the items and perk effects that share this text, by version. */
export function GroupedPerks({
  perks,
  currentHash,
}: {
  perks: GroupedPerk[];
  currentHash?: number;
}) {
  const data = useDataStore((state) => state.data);
  const { blocks, summary } = useMemo(() => entryView(perks, data), [perks, data]);
  const moves = data?.bundle.inactiveMoves;
  // Perk effects are not in the item catalog: their names come from the bundled sandbox perk
  // text, loaded once when this list first opens.
  const sandbox = useSandboxPerkText();
  const unnamed = blocks.some(({ rows }) => rows.some((row) => !row.perk?.name));
  useEffect(() => {
    if (unnamed) void loadSandboxPerkText();
  }, [unnamed]);
  const nameOf = ({ hash, kind, perk }: EntryRow) => {
    if (perk?.name) return perk.name;
    if (!sandbox) return <em>Loading name…</em>;
    // A failed load leaves the text empty: that says nothing about the perk itself.
    if (sandboxPerkTextFailed()) return <em>Name unavailable</em>;
    const name = sandboxPerkName(hash, sandbox);
    if (name) return name;
    // Some perk effects have a blank name in the game.
    return <em>{kind === 'Perk effect' ? 'Unnamed perk effect' : 'Not in the game data'}</em>;
  };
  return (
    <div className={styles.grouped}>
      <p className={styles.summary}>{summary}</p>
      {blocks.map((block) => (
        <section key={block.title} aria-label={block.title || groupedLabel}>
          {block.title && (
            <h3 className={block.enhanced ? styles.enhanced : undefined}>
              {block.enhanced && <EnhancedArrow />} {block.title}
            </h3>
          )}
          <ul>
            {block.rows.map((row) => (
              <li
                key={row.hash}
                data-grouped={row.hash}
                data-unattached={row.unattached ? '' : undefined}
              >
                <span className={styles.kind}>{row.kind}</span>
                <code className={styles.hash}>{row.hash}</code>
                <span className={styles.text}>
                  <span data-name>{nameOf(row)}</span>
                  <Notes row={row} />
                  {row.perk && row.perk.reason !== 'sandbox' && (
                    <GroupRemoveControl
                      hash={row.hash}
                      name={row.perk.name}
                      className={pageStyles.ghost}
                    />
                  )}
                </span>
                {row.perk && currentHash !== undefined && row.hash !== currentHash && (
                  <span className={styles.actions}>
                    <InactiveMoveControl
                      hash={row.hash}
                      name={
                        row.perk.name ||
                        (sandbox && sandboxPerkName(row.hash, sandbox)) ||
                        `Tooltip ${row.hash}`
                      }
                      moves={moves}
                      onSaved={applyInactiveMoves}
                      className={pageStyles.ghost}
                      compact
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Notes({ row: { hash, perk, mark, joined, unattached } }: { row: EntryRow }) {
  const shared = perk?.sharedBy && new Intl.ListFormat('en').format(perk.sharedBy);
  return (
    <>
      {mark && <strong>{mark}</strong>}
      {joined && <span>{joined}</span>}
      {shared && <span>Shared by {shared}</span>}
      {unattached && (
        <span title={unattached.others}>
          {unattached.why}
          {unattached.review && (
            <>
              {' '}
              <Link
                to={`/sandbox-perks?perk=${hash}`}
                aria-label={`Review ${hash} on the Sandbox perks page`}
              >
                Review
              </Link>
            </>
          )}
        </span>
      )}
    </>
  );
}
