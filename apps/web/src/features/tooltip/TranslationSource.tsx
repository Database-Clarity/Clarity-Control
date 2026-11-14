import type { Lang } from '@clarity/core';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { TermLayer } from '../terms/TermLayer';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import styles from './TooltipPage.module.scss';

/**
 * The English the translation follows, in the right pane: rendered text, or, when the English
 * has changed since the translation, what changed. "Shows" picks which; the last pick is kept on
 * this device and Settings gives the default until then.
 */
export function TranslationSource({
  text,
  diff,
  hash,
  terms,
}: {
  text: string | undefined;
  hash?: number;
  diff?: { hash: number; sourceUpdatedAt: string; current: string };
  /**
   * Official game names over the current English (TR2): `enabled` for a language the account may
   * translate (its names file loads lazily), `canInsert` while the translation can be edited.
   */
  terms?: { lang: Lang; enabled: boolean; canInsert: boolean; stepping: boolean };
}) {
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const remember = useSettingsStore((state) => state.remember);
  const showChanges = (remembered ?? fallback) === 'changes';

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
        </RightPaneHeader>
      }
    >
      {diff && showChanges ? (
        <EnglishDiffContent {...diff} />
      ) : text && terms && hash !== undefined ? (
        <TermLayer
          lang={terms.lang}
          hash={hash}
          enabled={terms.enabled}
          canInsert={terms.canInsert}
          stepping={terms.stepping}
        >
          <ReadingTooltip text={text} hash={hash} />
        </TermLayer>
      ) : text ? (
        <ReadingTooltip text={text} hash={hash} />
      ) : (
        <p>This tooltip has no English text yet.</p>
      )}
    </RightPane>
  );
}
