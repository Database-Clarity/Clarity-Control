import type { Lang } from '@clarity/core';
import type { ReactNode } from 'react';
import { VersionSwitch } from '../preview/PreviewColumn';
import { ReadingCompare } from '../preview/ReadingCompare';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import type { PreviewMode } from '../preview/previewMode';
import { NumberEnglishSource } from './NumberEnglishSource';
import { useNumberDocument } from '../editor/numbers/documents';
import { translationView } from '../terms/insert';
import { startFromEnglish } from '../editor/numbers/NumberTools';
import { useShowEditor } from './VariantWorkspace';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { EnglishRaw } from './EnglishRaw';
import { TitleAnchor } from '../preview/MarkupRenderer';
import styles from './TooltipPage.module.scss';

/**
 * The English the translation follows, in the right pane: rendered text, or, when the English
 * has changed since the translation, what changed. "Shows" picks which; the last pick is kept on
 * this device and Settings gives the default until then.
 *
 * An item with an enhanced version shows Base, Enhanced, or Compare (default: both versions as
 * one text, the enhanced values beside the base ones), the preview's own switch; Markup shows the
 * English markup of the picked version. Both picks are remembered on this device.
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
  enhanced?: { hash: number; text: string; sourceHash?: number };
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
  const showEditor = useShowEditor();

  const rendered = !text ? null : version === 'compare' && enhanced && hash !== undefined ? (
    <ReadingCompare
      baseText={text}
      baseHash={hash}
      enhancedText={enhanced.text}
      enhancedHash={enhanced.hash}
      enhancedSourceHash={enhanced.sourceHash}
    />
  ) : version === 'enhanced' && enhanced ? (
    <ReadingTooltip text={enhanced.text} hash={enhanced.hash} sourceHash={enhanced.sourceHash} />
  ) : (
    <ReadingTooltip text={text} hash={hash} />
  );
  const content = (renderAfter?: (text: string, offset: number) => ReactNode) =>
    diff && showChanges ? (
      <EnglishDiffContent {...diff} renderAfter={renderAfter} />
    ) : raw && text ? (
      <EnglishRaw
        text={version === 'enhanced' && enhanced ? enhanced.text : text}
        sourceHash={
          version === 'enhanced' && enhanced ? (enhanced.sourceHash ?? enhanced.hash) : hash
        }
      />
    ) : (
      (rendered ?? <p>This tooltip has no English text yet.</p>)
    );

  return (
    <RightPane
      label="English source"
      header={
        <RightPaneHeader title="English">
          {terms && hash !== undefined && (
            <StartEnglish
              hash={hash}
              lang={terms.lang}
              canInsert={terms.canInsert}
              onInsert={showEditor}
            />
          )}
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
        </RightPaneHeader>
      }
    >
      {!showChanges && text && (
        // Its own row under the header: the header also holds the pane tabs, and a 384px pane
        // cannot fit both (visual review 2026-11-14).
        <div className={styles.englishBar}>
          <VersionSwitch
            label="English version"
            value={version}
            hasEnhanced={Boolean(enhanced)}
            onChange={(next) => remember({ englishVersion: next })}
          />
          <TitleAnchor
            part={{
              title: [
                {
                  linesContent: [
                    {
                      text: raw
                        ? 'Show the English rendered (term marks show there; Ctrl+K, then G lists them)'
                        : 'Show the English markup, read-only and copyable',
                    },
                  ],
                },
              ],
            }}
          >
            <button
              type="button"
              role="switch"
              aria-label="English markup"
              aria-checked={raw}
              className={styles.markupToggle}
              onClick={() => remember({ englishRaw: !raw })}
            >
              Markup
            </button>
          </TitleAnchor>
        </div>
      )}
      {text && terms && hash !== undefined ? (
        <NumberEnglishSource
          lang={terms.lang}
          hash={hash}
          text={text}
          enabled={terms.enabled}
          canInsert={terms.canInsert}
          stepping={terms.stepping}
          raw={raw && !showChanges}
          changes={showChanges}
        >
          {content}
        </NumberEnglishSource>
      ) : (
        content()
      )}
    </RightPane>
  );
}

import { useSyncExternalStore } from 'react';
function StartEnglish({
  hash,
  lang,
  canInsert,
  onInsert,
}: {
  hash: number;
  lang: Lang;
  canInsert: boolean;
  onInsert(): void;
}) {
  const store = useNumberDocument(hash, lang);
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!canInsert || typeof document === 'undefined') return null;
  const view = translationView(hash);
  if (!view || view.state.doc.length) return null;
  return (
    <button
      type="button"
      title="Copy English with its numbers as tokens (Ctrl+K, then S)"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (startFromEnglish(view)) onInsert();
      }}
    >
      Start from English
    </button>
  );
}
