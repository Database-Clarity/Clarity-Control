import styles from './TooltipPage.module.scss';

/** Read-only English markup that a translation is based on. */
export function TranslationSource({ text }: { text: string | undefined }) {
  return (
    <>
      <h3>English source</h3>
      {text ? (
        <pre className={styles.sourceText} lang="en">
          {text}
        </pre>
      ) : (
        <p>This tooltip has no English text yet.</p>
      )}
    </>
  );
}
