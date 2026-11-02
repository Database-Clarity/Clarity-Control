import { useEffect, useState } from 'react';
import { EnglishDiffContent } from '../translations/EnglishDiff';
import styles from './TooltipPage.module.scss';

/** Read-only English markup that a translation is based on. */
const preferenceKey = 'clarity-english-source-view';

export function TranslationSource({
  text,
  diff,
}: {
  text: string | undefined;
  diff?: { hash: number; sourceUpdatedAt: string; current: string };
}) {
  const [showChanges, setShowChanges] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    try {
      setShowChanges(localStorage.getItem(preferenceKey) !== 'current');
    } catch {
      setMessage('Cannot read the saved English source preference.');
    }
  }, []);
  function toggle() {
    const next = !showChanges;
    setShowChanges(next);
    try {
      localStorage.setItem(preferenceKey, next ? 'changes' : 'current');
      setMessage('');
    } catch {
      setMessage('Cannot save the English source preference.');
    }
  }

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
          {message && <p role="status">{message}</p>}
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
