import { useEffect } from 'react';
import { languages, langSchema, type Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Popover } from '../../ui/Popover';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import {
  loadSandboxPerkText,
  sandboxPerkName,
  sandboxPerkTextFailed,
  useSandboxPerkText,
} from '../manifest/manifestText';
import type { GroupedPerk } from './grouping';
import styles from './TooltipPage.module.scss';

export interface OverrideTarget {
  hash: number;
  name: string;
}

/** "Read-only: sign in to edit." -> "Read-only". */
export const shortReason = (reason: string) => reason.split(':')[0].trim();

/**
 * The 28px header above the editor: language, draft state, read-only reason, and the actions for
 * the enhanced version ("Edit override" where it keeps text of its own), and for maintainers the
 * manifest perks grouped into this entry. Everything is one line; flexible text ellipsises.
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
  overrides,
  activeOverride,
  onEditOverride,
  onBack,
  grouped,
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
  overrides: OverrideTarget[];
  activeOverride: OverrideTarget | undefined;
  onEditOverride(hash: number): void;
  onBack(): void;
  /** Maintainers only: the manifest perks this editor entry covers; undefined hides the control. */
  grouped?: GroupedPerk[];
  /** The button that shows and hides the markup row. */
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
      {markupTools}
      <span className={styles.paneRight}>
        {grouped && (
          <Popover
            label="Grouped manifest perks"
            className={styles.ghost}
            trigger={
              <>
                <span className={styles.groupedIcon} aria-hidden="true" />
                <span className={styles.groupedWord}>Grouped </span>
                {grouped.length}
              </>
            }
            triggerTitle="Which manifest perks open this editor entry, and how each joined (maintainers)"
          >
            <GroupedPerks perks={grouped} />
          </Popover>
        )}
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

/** The maintainer's read-only list: hash, in-game name, base or enhanced, and how it joined. */
export function GroupedPerks({ perks }: { perks: GroupedPerk[] }) {
  // Sandbox perks are not in the item catalog: their names come from the bundled sandbox perk
  // text, loaded once when this list first opens.
  const sandbox = useSandboxPerkText();
  const unnamed = perks.some((perk) => !perk.name);
  useEffect(() => {
    if (unnamed) void loadSandboxPerkText();
  }, [unnamed]);
  const nameOf = (perk: GroupedPerk) => {
    if (perk.name) return perk.name;
    if (!sandbox) return <em>Loading name…</em>;
    // A failed load leaves the text empty: that says nothing about the perk itself.
    if (sandboxPerkTextFailed()) return <em>Name unavailable</em>;
    // A sandbox alias comes from the manifest by construction; some definitions are blank.
    const name = sandboxPerkName(perk.hash, sandbox);
    if (name) return name;
    if (name === undefined && perk.reason !== 'sandbox')
      return <em>Not in the manifest catalog</em>;
    return <em>Unnamed sandbox perk</em>;
  };
  return (
    <ul className={styles.grouped}>
      {perks.map((perk) => (
        <li key={perk.hash} data-grouped={perk.hash}>
          <code className={styles.groupedHash}>{perk.hash}</code>
          <span className={styles.groupedName}>{nameOf(perk)}</span>
          <span className={perk.enhanced ? styles.groupedEnhanced : styles.groupedBase}>
            {perk.enhanced ? (
              <>
                <EnhancedArrow /> Enhanced
              </>
            ) : (
              'Base'
            )}
          </span>
          <span className={styles.groupedHow}>
            {perk.how}
            {perk.sharedBy && (
              <span title={perk.sharedBy.join(', ')}>
                {' · '}shared by {perk.sharedBy.length} owners
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
