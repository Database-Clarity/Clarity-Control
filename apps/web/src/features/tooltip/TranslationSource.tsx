import type { Lang } from '@clarity/core';
import { VersionSwitch } from '../preview/PreviewColumn';
import { ReadingCompare } from '../preview/ReadingCompare';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import type { PreviewMode } from '../preview/previewMode';
import { TermLayer } from '../terms/TermLayer';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { EnglishRaw } from './EnglishRaw';
import styles from './TooltipPage.module.scss';

/**
 * The English the translation follows, in the right pane: rendered text, or, when the English
 * has changed since the translation, what changed. "Shows" picks which; the last pick is kept on
 * this device and Settings gives the default until then.
 *
 * An item with an enhanced version shows Base, Enhanced, or Compare (default: both versions as
 * one text, the enhanced values beside the base ones), the preview's own switch; Raw shows the
 * English markup. Both picks are remembered on this device.
 */
export function TranslationSource({
  text,
  diff,
  hash,
  enhanced,
  terms,
}: {
  text: string | undefined;
  hash?: number;
  diff?: { hash: number; sourceUpdatedAt: string; current: string };
  /** The English of the item's enhanced version (owner 2026-11-14: translators must see it). */
  enhanced?: { hash: number; text: string };
  /**
   * Official game names over the current English (TR2): `enabled` for a language the account may
   * translate (its names file loads lazily), `canInsert` while the translation can be edited.
   */
  terms?: { lang: Lang; enabled: boolean; canInsert: boolean; stepping: boolean };
}) {
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const chosenVersion = useSettingsStore((state) => state.device.remembered.englishVersion);
  const raw = useSettingsStore((state) => state.device.remembered.englishRaw) === true;
  const remember = useSettingsStore((state) => state.remember);
  const showChanges = Boolean(diff) && (remembered ?? fallback) === 'changes';
  const version: PreviewMode = enhanced ? (chosenVersion ?? 'compare') : 'base';

  const rendered = !text ? null : version === 'compare' && enhanced && hash !== undefined ? (
    <ReadingCompare
      baseText={text}
      baseHash={hash}
      enhancedText={enhanced.text}
      enhancedHash={enhanced.hash}
    />
  ) : version === 'enhanced' && enhanced ? (
    <ReadingTooltip text={enhanced.text} hash={enhanced.hash} />
  ) : (
    <ReadingTooltip text={text} hash={hash} />
  );

  return (
    <RightPane
      label="English source"
      header={
        <RightPaneHeader title="English">
          {diff && (
            <label className={styles.showsLabel}>
              <span>Shows:</span>
              <select
                aria-label="English shows"
                value={showChanges ? 'changes' : 'current'}
                onChange={(event) =>
                  remember({
                    englishSource: event.target.value === 'changes' ? 'changes' : 'current',
                  })
                }
              >
                <option value="changes">Changes since translation</option>
                <option value="current">Current English</option>
              </select>
            </label>
          )}
          {!showChanges && text && (
            <>
              {!raw && (
                <VersionSwitch
                  label="English version"
                  value={version}
                  hasEnhanced={Boolean(enhanced)}
                  onChange={(next) => remember({ englishVersion: next })}
                  fill
                />
              )}
              <button
                type="button"
                role="switch"
                aria-label="Raw English markup"
                aria-checked={raw}
                className={styles.rawToggle}
                title={
                  raw
                    ? 'Show the English rendered (term marks show there)'
                    : 'Show the English markup, read-only and copyable'
                }
                onClick={() => remember({ englishRaw: !raw })}
              >
                Raw
              </button>
            </>
          )}
        </RightPaneHeader>
      }
    >
      {diff && showChanges ? (
        <EnglishDiffContent {...diff} />
      ) : raw && text ? (
        <EnglishRaw text={version === 'enhanced' && enhanced ? enhanced.text : text} />
      ) : rendered && terms && hash !== undefined ? (
        <TermLayer
          lang={terms.lang}
          hash={hash}
          enabled={terms.enabled}
          canInsert={terms.canInsert}
          stepping={terms.stepping}
        >
          {rendered}
        </TermLayer>
      ) : rendered ? (
        rendered
      ) : (
        <p>This tooltip has no English text yet.</p>
      )}
    </RightPane>
  );
}
