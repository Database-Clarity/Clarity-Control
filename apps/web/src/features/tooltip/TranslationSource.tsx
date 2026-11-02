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
  // The last click is remembered on this device; Settings gives the default until then.
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const remember = useSettingsStore((state) => state.remember);
  const showChanges = (remembered ?? fallback) === 'changes';
  const toggle = () => remember({ englishSource: showChanges ? 'current' : 'changes' });

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
