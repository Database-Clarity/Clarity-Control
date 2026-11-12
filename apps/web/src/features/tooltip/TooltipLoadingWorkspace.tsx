import { seesReports, reportLanguages } from '../reports/pane/indexStore';
import { VariantWorkspace } from './VariantWorkspace';
import { EditorPaneHeader } from './EditorPaneHeader';
import { ClarityEditor } from '../editor';
import { PreviewColumn } from '../preview';
import { ShellSlot } from '../navigation/ShellSlots';
import type { useShellColumn } from '../navigation/ShellColumnContext';
import type { useAuthStore } from '../../stores/auth';
import type { useMarkupRow } from '../editor/markupRow/useMarkupRow';
import { SkeletonBoundary } from '../../ui/Skeleton';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import type { Lang } from '@clarity/core';
import styles from './TooltipPage.module.scss';

const noop = () => {};
const globals = { variables: '', titles: '' };

/** Same frame, controls, divider, and device state as the loaded workspace. */
export function loadingWorkspace({
  hash,
  lang,
  column,
  user,
  markup,
}: {
  hash: number;
  lang: Lang;
  column: ReturnType<typeof useShellColumn>;
  user: ReturnType<typeof useAuthStore.getState>['user'];
  markup: ReturnType<typeof useMarkupRow>;
}) {
  const preview = (
    <PreviewColumn
      hash={hash}
      lang={lang}
      name={`Tooltip ${hash}`}
      baseText=""
      baseGlobals={globals}
      enhanced={[]}
      mode="base"
      onMode={noop}
      variant={undefined}
      onVariant={noop}
      loadingContent
    />
  );
  const pane = (title: string) => (
    <RightPane busy label={`${title} for ${hash}`} header={<RightPaneHeader title={title} />}>
      <SkeletonBoundary pending label={`Loading ${title} content…`} count={8} />
    </RightPane>
  );
  const workspace = (
    <VariantWorkspace
      header={
        <fieldset disabled style={{ display: 'contents', border: 0, margin: 0, padding: 0 }}>
          <EditorPaneHeader
            lang={lang}
            onLanguage={noop}
            draft={false}
            saving={false}
            onDiscard={noop}
            reason={null}
            onSwitch={noop}
            overrides={[]}
            activeOverride={undefined}
            onEditOverride={noop}
            onBack={noop}
            markup={markup}
          />
        </fieldset>
      }
      editor={
        <section className={styles.editorSection} aria-label="Loading editor">
          <div className={styles.editorSlot}>
            <ClarityEditor
              value=""
              lang={lang}
              globals={globals}
              onChange={noop}
              readOnly
              pending
              markupRow={markup.open}
              preview={column ? { collapsed: column.collapsed, onShow: column.show } : undefined}
            />
          </div>
        </section>
      }
      preview={column ? null : <div className={styles.inlinePreview}>{preview}</div>}
      compendium={user?.role !== 'translator' ? pane('Compendium') : null}
      reports={
        seesReports(user) && (reportLanguages(user)?.includes(lang) ?? true)
          ? { count: null, pane: pane('Reports') }
          : undefined
      }
    />
  );
  const left = column && (
    <ShellSlot name="left">
      <div className={styles.leftStack}>
        <div className={styles.previewBody}>{preview}</div>
      </div>
    </ShellSlot>
  );
  return { workspace, left };
}
