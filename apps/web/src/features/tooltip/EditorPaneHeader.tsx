import { languages, langSchema, type Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Popover } from '../../ui/Popover';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import styles from './TooltipPage.module.scss';

export interface OverrideTarget {
  hash: number;
  name: string;
}

/** "Read-only: sign in to edit." -> "Read-only". */
export const shortReason = (reason: string) => reason.split(':')[0].trim();

/**
 * The 28px header above the editor: language, draft state, read-only reason, and the actions for
 * the enhanced version ("Stored form" for maintainers on derived versions; "Edit override" where
 * the enhanced version keeps text of its own). Everything is one line; flexible text ellipsises.
 */
export function EditorPaneHeader({
  lang,
  onLanguage,
  draft,
  saving,
  onDiscard,
  reason,
  switchTo,
  onSwitch,
  details,
  overrides,
  activeOverride,
  onEditOverride,
  onBack,
  storedForms,
  markupTools,
}: {
  lang: Lang;
  onLanguage(lang: Lang): void;
  /** Whether the text being edited has an unsaved draft. */
  draft: boolean;
  saving: boolean;
  onDiscard(): void;
  /** Why the editor is read-only; null when it is editable. */
  reason: string | null;
  switchTo?: Lang;
  onSwitch(lang: Lang): void;
  /** Who edited it and when; opens from the "Details" button. */
  details: React.ReactNode;
  overrides: OverrideTarget[];
  activeOverride: OverrideTarget | undefined;
  onEditOverride(hash: number): void;
  onBack(): void;
  /** Maintainers only: derived enhanced versions and their stored text. */
  storedForms: { target: OverrideTarget; node: React.ReactNode }[];
  /** Wired by the markup row (step 8); not rendered until then. */
  markupTools?: React.ReactNode;
}) {
  return (
    <>
      <select
        className={styles.langSelect}
        aria-label="Language"
        value={lang}
        onChange={(event) => onLanguage(langSchema.parse(event.target.value))}
      >
        {languages.map((language) => (
          <option key={language} value={language}>
            {languageLabel(language)}
          </option>
        ))}
      </select>
      {activeOverride && (
        <span className={styles.overrideTag}>
          <EnhancedArrow /> Enhanced override
          {overrides.length > 1 && <span className={styles.ell}>: {activeOverride.name}</span>}
        </span>
      )}
      {!draft && (
        // Holds the place of the draft dot and Discard on a phone, where this row wraps, so the
        // first edit does not push the text down. It takes no space elsewhere.
        <span className={styles.draftSpacer} aria-hidden="true">
          <span className={styles.dot} />
          <span className={styles.ghost}>Discard</span>
        </span>
      )}
      {draft && (
        <>
          <span
            className={styles.dot}
            role="img"
            aria-label="Unsaved draft"
            title="Unsaved draft"
          />
          <button
            type="button"
            className={styles.ghost}
            disabled={saving}
            aria-label="Discard this tooltip's draft"
            onClick={onDiscard}
          >
            Discard
          </button>
        </>
      )}
      {reason && (
        // The status bar under the editor says the whole sentence; the badge only names the state
        // (its tooltip has the sentence too), so the same words are not on screen twice.
        <span className={styles.badge} role="status" title={reason}>
          <span className={styles.ell}>{shortReason(reason)}</span>
          {switchTo && (
            <button type="button" className={styles.ghost} onClick={() => onSwitch(switchTo)}>
              Switch to {languageLabel(switchTo)}
            </button>
          )}
        </span>
      )}
      <Popover
        label="Edit history of this text"
        className={styles.ghost}
        trigger="Details"
        triggerTitle="Who last edited this text, and when"
      >
        {details}
      </Popover>
      {markupTools}
      <span className={styles.paneRight}>
        {storedForms.map(({ target, node }) => (
          <Popover
            key={target.hash}
            label={`Stored form${storedForms.length > 1 ? `: ${target.name}` : ''}`}
            className={styles.ghost}
            trigger={`Stored form${storedForms.length > 1 ? `: ${target.name}` : ''}`}
            triggerTitle="The text stored for the enhanced version (read only)"
          >
            {node}
          </Popover>
        ))}
        {activeOverride ? (
          <button type="button" className={styles.ghost} onClick={onBack}>
            Back to base
          </button>
        ) : (
          overrides.map((target) => (
            <button
              key={target.hash}
              type="button"
              className={styles.ghost}
              onClick={() => onEditOverride(target.hash)}
            >
              Edit override{overrides.length > 1 ? `: ${target.name}` : ''}
            </button>
          ))
        )}
      </span>
    </>
  );
}
