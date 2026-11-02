import { useState } from 'react';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import { useSettingsStore } from '../../stores/settings';
import styles from './TooltipPage.module.scss';

/** Read-only English markup that a translation is based on. */

export function TranslationSource({
  text,
  diff,
}: {
  text: string | undefined;
  diff?: { hash: number; sourceUpdatedAt: string; current: string };
}) {
  // The default comes from Settings; toggling here changes this view only.
  const [showChanges, setShowChanges] = useState(
    () => useSettingsStore.getState().settings.englishSource === 'changes',
  );
  const toggle = () => setShowChanges(!showChanges);

  return (
    <>
      <h3>English source</h3>
      {diff && (
        <>
          <h3>English changes since this translation</h3>
          <button
            type="button"
            aria-label="Show English changes"
            aria-pressed={showChanges}
            onClick={toggle}
          >
            {showChanges ? 'Current English' : 'Show changes'}
          </button>
        </>
      )}
      {diff && showChanges ? (
        <EnglishDiffContent {...diff} />
      ) : text ? (
        <pre className={styles.sourceText} lang="en">
          {text}
        </pre>
      ) : (
        <p>This tooltip has no English text yet.</p>
      )}
    </>
  );
}
