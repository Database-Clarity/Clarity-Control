import { SkeletonBoundary } from '../../ui/Skeleton';
import { useEffect, useMemo, useState } from 'react';
import type { Lang } from '@clarity/core';
import { useLocalisedManifest } from './localisedManifest';
import { EnglishReveal } from './EnglishReveal';
import { useDataStore } from '../../stores/data';
import { canonicalHash, itemFor, variantHashes } from '../navigation/catalog';
import { diffWords } from '../../ui/diff/diffWords';
import { ManifestStatsRow } from './ManifestStatsRow';
import { PanelRow } from '../../ui/PanelRow';
import {
  loadSandboxPerkText,
  manifestSummary,
  manifestText,
  manifestDescription,
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
export function ManifestTextRow({
  hash: requestedHash,
  lang = 'en',
  enhancedHash: selectedEnhancedHash,
}: {
  hash: number;
  lang?: Lang;
  enhancedHash?: number;
}) {
  const data = useDataStore((state) => state.data);
  const hash = data ? canonicalHash(requestedHash, data) : requestedHash;
  const variants = data ? variantHashes(hash, data) : [];
  const enhancedHash = data
    ? requestedHash !== hash && variants.includes(requestedHash)
      ? requestedHash
      : (variants.find((value) => value === selectedEnhancedHash && value !== hash) ??
        variants.find((value) => value !== hash))
    : undefined;
  const perks = useSandboxPerkText();
  const [open, setOpen] = useState(stored);
  // Fetch the perk text once, off the first paint; stepping then reads it from memory.
  useEffect(() => {
    void loadSandboxPerkText();
  }, []);
  const item = data ? itemFor(hash, data) : undefined;
  const text = useMemo(() => manifestText(item, perks), [item, perks]);
  const localised = useLocalisedManifest(lang);
  const enhancedText = useMemo(
    () =>
      manifestText(
        data && enhancedHash !== undefined ? itemFor(enhancedHash, data) : undefined,
        perks,
      ),
    [data, enhancedHash, perks],
  );
  const description = (value: typeof text, itemHash: number) => {
    if (value.kind === 'own')
      return localised?.descriptions?.[itemHash]?.trim() || value.description;
    if (value.kind === 'sandbox')
      return value.perks
        .map((perk) => localised?.sandboxPerks?.[perk.hash]?.[1]?.trim() || perk.description)
        .join('\n');
    return manifestDescription(value);
  };
  const before = description(text, hash),
    after = description(enhancedText, enhancedHash ?? hash);
  const differences = useMemo(() => diffWords(before, after), [before, after]);
  const translated = useMemo(() => {
    if (text.kind === 'own') {
      return { ...text, description: localised?.descriptions?.[hash]?.trim() || text.description };
    }
    if (text.kind === 'sandbox') {
      return {
        ...text,
        perks: text.perks.map((perk) => {
          const line = localised?.sandboxPerks?.[perk.hash];
          return line?.[1].trim()
            ? { ...perk, name: line[0].trim() || perk.name, description: line[1] }
            : perk;
        }),
      };
    }
    return text;
  }, [text, localised, hash]);
  if (!data) return null;
  const summary = manifestSummary(translated);
  const unavailable = text.kind === 'none' && text.perkHashes.length > 0 && sandboxPerkTextFailed();
  return (
    <>
      <ManifestStatsRow hash={hash} enhancedHash={enhancedHash} lang={lang} />
      <section
        aria-label={`Manifest text for ${item?.name ? `${item.name}, ` : ''}${hash}`}
        className={styles.panel}
      >
        <PanelRow
          label="Manifest text"
          summary={
            // Open, the preview card right above already names the entry: no second identity.
            open ? undefined : (
              <span className={styles.summary} data-empty={text.kind === 'none' || undefined}>
                <EnglishReveal
                  english={manifestSummary(text)}
                  translated={summary}
                  lang={lang}
                  showTranslation
                />
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
            {text.kind === 'own' && (
              <p className={styles.text}>
                <EnglishReveal
                  english={text.description}
                  translated={localised?.descriptions?.[hash]}
                  lang={lang}
                />
              </p>
            )}
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
                        <EnglishReveal
                          english={perk.name || 'Unnamed perk'}
                          translated={localised?.sandboxPerks?.[perk.hash]?.[0]}
                          lang={lang}
                        />{' '}
                        <span>· {perk.hash}</span>
                      </dt>
                      {/* A stat line ("-10 Grenade") is its own name: say it once. */}
                      <dd className={perk.description === perk.name ? 'sr-only' : styles.text}>
                        {perk.description === perk.name ? (
                          'Same as the perk name.'
                        ) : (
                          <EnglishReveal
                            english={perk.description}
                            translated={localised?.sandboxPerks?.[perk.hash]?.[1]}
                            lang={lang}
                          />
                        )}
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
          {enhancedHash !== undefined && (
            <SkeletonBoundary
              pending={text.kind === 'loading' || enhancedText.kind === 'loading'}
              identity={`${hash}:${enhancedHash}`}
              label="Loading enhanced manifest text…"
            >
              <div className={styles.enhancedText}>
                <p className={styles.hint}>
                  {before === after ? 'Enhanced: same text' : 'Enhanced'}
                </p>
                {before !== after && (
                  <p className={styles.text}>
                    {differences.map((part, index) =>
                      part.kind === 'delete' ? (
                        <del key={index}>{part.text}</del>
                      ) : part.kind === 'insert' ? (
                        <ins className={styles.enhanced} key={index}>
                          {part.text}
                        </ins>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </p>
                )}
              </div>
            </SkeletonBoundary>
          )}
        </PanelRow>
      </section>
    </>
  );
}
