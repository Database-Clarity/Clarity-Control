import { EnglishDiffContent } from '../translations/EnglishDiff';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import styles from './TooltipPage.module.scss';

/**
 * The English the translation follows, in the right pane: read-only markup, or, when the English
 * has changed since the translation, what changed. "Shows" picks which; the last pick is kept on
 * this device and Settings gives the default until then.
 */
export function TranslationSource({
  text,
  diff,
}: {
  text: string | undefined;
  diff?: { hash: number; sourceUpdatedAt: string; current: string };
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
      ) : text ? (
        <pre className={styles.sourceText} lang="en">
          {text}
        </pre>
      ) : (
        <p>This tooltip has no English text yet.</p>
      )}
    </RightPane>
  );
}
