import { isMovedInactive } from '@clarity/core';
import { applyInactiveMoves, useDataStore } from '../../stores/data';
import { PanelRow } from '../../ui/PanelRow';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { InactiveMoveControl } from './InactiveMoveControl';
import styles from './InactiveEditor.module.scss';

const notice =
  'Inactive — excluded from outputs when this row is published. Text remains editable.';

function useMovedInactive(hash: number | undefined): boolean {
  return useDataStore(
    (state) => hash !== undefined && isMovedInactive(hash, state.data?.bundle.inactiveMoves),
  );
}

/** Thin editor adapter: the editor and its props stay mounted as the notice changes. */
export function InactiveClarityEditor(props: ClarityEditorProps) {
  const inactive = useMovedInactive(props.tooltipHash);
  return (
    <div className={styles.frame}>
      {inactive && (
        <div className={styles.notice} role="note">
          {notice}
        </div>
      )}
      <ClarityEditor {...props} />
    </div>
  );
}

/** Connected here so TooltipPage needs only a single additive mount. */
export function InactiveHeaderControl({
  hash,
  name,
  className,
  compact,
}: {
  hash: number;
  name: string;
  className?: string;
  compact: boolean;
}) {
  const moves = useDataStore((state) => state.data?.bundle.inactiveMoves);
  return (
    <InactiveMoveControl
      hash={hash}
      name={name}
      moves={moves}
      className={className}
      compact={compact}
      onSaved={applyInactiveMoves}
    />
  );
}

/** On a phone the Preview tab needs the notice too; desktop already shows it in the editor. */
export function InactivePreviewNotice({ hash, phone }: { hash: number; phone: boolean }) {
  const inactive = useMovedInactive(hash);
  return phone && inactive ? (
    <PanelRow label={<span title={notice}>{notice}</span>} className={styles.previewNotice} />
  ) : null;
}
