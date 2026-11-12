import { SkeletonBoundary } from '../../ui/Skeleton';
import { useEffect, useMemo, useState } from 'react';
import { useDataStore } from '../../stores/data';
import { itemFor } from '../navigation/catalog';
import { PanelRow } from '../../ui/PanelRow';
import {
  loadSandboxPerkText,
  manifestSummary,
  manifestText,
  sandboxPerkTextFailed,
  useSandboxPerkText,
} from './manifestText';
import styles from './ManifestTextRow.module.scss';

const key = 'clarity.manifestText.open';
function stored(): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

/**
 * The manifest (in-game API) text of the entry being edited, for reference: its own description,
 * or, for entries that have none, the descriptions of its sandbox perks. A row under the preview,
 * so it never moves editor text. Open by default; the choice is remembered on this device.
 * Everything comes from the loaded catalogue plus one bundled perk-text chunk fetched once.
 */
export function ManifestTextRow({ hash }: { hash: number }) {
  const data = useDataStore((state) => state.data);
  const perks = useSandboxPerkText();
  const [open, setOpen] = useState(stored);
  // Fetch the perk text once, off the first paint; stepping then reads it from memory.
  useEffect(() => {
    void loadSandboxPerkText();
  }, []);
  const item = data ? itemFor(hash, data) : undefined;
  const text = useMemo(() => manifestText(item, perks), [item, perks]);
  if (!data) return null;
  const summary = manifestSummary(text);
  const unavailable = text.kind === 'none' && text.perkHashes.length > 0 && sandboxPerkTextFailed();
  return (
    <section
      aria-label={`Manifest text for ${item?.name ? `${item.name}, ` : ''}${hash}`}
      className={styles.panel}
    >
      <PanelRow
        label="Manifest text"
        summary={
          // Open, the preview card right above already names the entry: no second identity.
          open ? undefined : (
            <span title={summary} data-empty={text.kind === 'none' || undefined}>
              {summary}
            </span>
          )
        }
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          try {
            localStorage.setItem(key, next ? '1' : '0');
          } catch {
            // Private mode: the choice lasts for this page only.
          }
        }}
      >
        <SkeletonBoundary
          pending={text.kind === 'loading'}
          identity={hash}
          label="Loading sandbox perk text…"
        >
          {text.kind === 'own' && <p className={styles.text}>{text.description}</p>}
          {text.kind === 'sandbox' && (
            <>
              <p className={styles.hint}>
                No description of its own. From its sandbox{' '}
                {text.perks.length === 1 ? 'perk' : 'perks'}:
              </p>
              <dl className={styles.perks}>
                {text.perks.map((perk) => (
                  <div key={perk.hash}>
                    <dt>
                      {perk.name || 'Unnamed perk'} <span>· {perk.hash}</span>
                    </dt>
                    {/* A stat line ("-10 Grenade") is its own name: say it once. */}
                    <dd className={perk.description === perk.name ? 'sr-only' : styles.text}>
                      {perk.description === perk.name ? 'Same as the perk name.' : perk.description}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {text.kind === 'none' && (
            <p className={styles.hint}>
              {unavailable
                ? 'No description of its own, and the sandbox perk text failed to load.'
                : text.perkHashes.length
                  ? `No manifest description, and none on its sandbox ${text.perkHashes.length === 1 ? 'perk' : 'perks'} (${text.perkHashes.join(', ')}).`
                  : 'No manifest description.'}
            </p>
          )}
        </SkeletonBoundary>
      </PanelRow>
    </section>
  );
}
