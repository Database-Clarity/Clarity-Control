import { lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { MarkupGlobals } from '@clarity/core';
import { Dialog } from '../../ui/Dialog';
import { InlineAlert } from '../../ui/InlineAlert';
import { plainError } from '../../services/httpError';
import { EnhancedArrow, WithArrows, ENHANCED_ARROW_CHAR } from '../../ui/EnhancedArrow';
import { PaneDivider } from '../../ui/PaneDivider';
import { usePaneDivider } from '../../ui/usePaneDivider';
import { PanelRow } from '../../ui/PanelRow';
import { PlaceholderPage } from '../../ui/PlaceholderPage';
import { Popover } from '../../ui/Popover';
import { RightPane, RightPaneHeader, RightPaneTabsContext, Segmented } from '../../ui/RightPane';
import {
  LoadingSkeleton,
  SkeletonBlock,
  SkeletonBoundary,
  SkeletonLine,
  SkeletonRegion,
  SkeletonRows,
  SkeletonStatus,
  SkeletonSuspense,
} from '../../ui/Skeleton';
import { VirtualList } from '../../ui/VirtualList';
import { When } from '../../ui/When';
import { WordDiff } from '../../ui/diff';
import { InactiveMoveConfirm } from '../tooltip/InactiveMoveControl';
import { NoticeStrip } from '../navigation/NoticeStrip';
import type { ShellNotice } from '../navigation/notices';
import { FinderMarkers } from '../navigation/FinderMarkers';
import { GearIcon } from '../navigation/SettingsButton';
import { BrandMark } from '../navigation/Brand';
import { ArchiveIcon } from '../archive/ArchiveIcon';
import { MarkupSnippet } from '../preview/TooltipPreview';
import { HistoryWordDiff } from '../history/HistoryWordDiff';
import { RawDiffToggle } from '../history/RawDiffToggle';
import { SheetCell, SheetColoursToggle } from '../compendium/sheetSurface';
import { Multiline } from '../compendium/RichCell';
import { BuildDot } from '../exports/BuildStatus';
import { EntryGlyph } from '../editor/markupRow/EntryGlyph';
import { ScaleControl } from '../settings/SettingsContent';
import { liveEntries } from './liveEntries';
import { SnippetErrorsDemo, SnippetListDemo } from './snippetDemos';
import styles from './Gallery.module.scss';

/** One state of an element, rendered as a component so demos may hold their own state. */
export interface GalleryState {
  label: string;
  View: ComponentType;
}

export interface GalleryEntry {
  id: string;
  group: string;
  title: string;
  /** The import path, from apps/web/src. */
  from: string;
  /** One line: when to use it. */
  note: string;
  /** Components exported from apps/web/src/ui/** that this entry shows (the coverage guard). */
  covers?: readonly string[];
  states: readonly GalleryState[];
}

/** Real long localized strings (no right-to-left scripts): German, Polish, and Russian. */
const long = {
  de: 'Änderungen an allen ausgewählten Übersetzungen speichern und veröffentlichen',
  pl: 'Zapisz zmiany we wszystkich zaznaczonych tłumaczeniach przed publikacją',
  ru: 'Сохранить изменения во всех выбранных переводах перед публикацией',
};

const globals: MarkupGlobals = { variables: `var e = ${ENHANCED_ARROW_CHAR}`, titles: '' };

const markup = [
  'title jolted (',
  'Chains lightning to up to 3 nearby targets.',
  ')',
  '<bold Special note: /> Final blows with <arc Jolt /> chain to <stasis/> frozen targets.',
  '• Rate of fire: 25%<arrow/>30%',
  '• <pve +40% /> damage, <pvp [+15%] /> against Guardians',
  '<exotic Gjallarhorn /> applies <title jolted [Jolt] /> on <solar Scorch /> and <void Weaken />.',
].join('\n');

const before = 'Final blows with this weapon grant 20% reload speed for 5 seconds. Stacks 3 times.';
const after =
  'Final blows with this weapon grant 25% reload speed for 6 seconds. Stacks up to 3 times.';

function Row({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}

const s = (label: string, View: ComponentType): GalleryState => ({ label, View });

// ---- Demos that hold state -------------------------------------------------------------------

function DialogDemo({
  variant,
  busy = false,
  title = 'Discard local changes?',
  opener = `Open ${variant} dialog`,
}: {
  variant: 'default' | 'compact' | 'form';
  busy?: boolean;
  title?: string;
  opener?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={styles.button} onClick={() => setOpen(true)}>
        {opener}
      </button>
      {open && (
        <Dialog
          title={title}
          onClose={() => setOpen(false)}
          busy={busy}
          compact={variant === 'compact'}
          form={variant === 'form'}
          footer={
            <>
              <button type="button" className={styles.button} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                {busy ? 'Saving…' : variant === 'form' ? 'Create' : 'Discard'}
              </button>
            </>
          }
        >
          {variant === 'form' ? (
            <label className={styles.field}>
              Batch name
              <input className={styles.input} defaultValue="Season of the Wish fixes" />
            </label>
          ) : (
            <p>
              Your 3 unsaved edits on Chain Reaction are removed from this device. Saved text is not
              affected.
            </p>
          )}
          {busy && <p role="status">Busy: Escape and Close are disabled until it finishes.</p>}
        </Dialog>
      )}
    </>
  );
}

function MoveConfirmDemo({
  moved = false,
  loaded = true,
  saving = false,
  error = null,
  name = 'Chain Reaction',
}: {
  moved?: boolean;
  loaded?: boolean;
  saving?: boolean;
  error?: string | null;
  name?: string;
}) {
  return (
    <Popover
      label={moved ? 'Move out of Inactive' : 'Move to Inactive'}
      trigger={moved ? 'Move out of Inactive' : 'Move to Inactive'}
      contain
      width={360}
      className={styles.trigger}
    >
      {(close) => (
        <InactiveMoveConfirm
          moved={moved}
          name={name}
          loaded={loaded}
          saving={saving}
          error={error}
          onCancel={() => close()}
          onMove={() => close()}
        />
      )}
    </Popover>
  );
}

function PanelRowDemo({ open: start = false, long: isLong = false }) {
  const [open, setOpen] = useState(start);
  return (
    <div className={styles.wide}>
      <PanelRow
        // A long label does not shrink (only the summary ellipsises): the long state keeps the
        // label short, as every real row's label is.
        label={isLong ? 'Verlauf' : 'History'}
        summary={isLong ? long.ru : '12 commits · last 2 days ago'}
        actions={
          <button type="button" className={styles.button}>
            Load more
          </button>
        }
        open={open}
        onOpenChange={setOpen}
      >
        <p className={styles.plain}>The body is mounted only while the row is open.</p>
      </PanelRow>
    </div>
  );
}

function PaneTabsDemo() {
  const [active, setActive] = useState('compendium');
  return (
    <RightPaneTabsContext.Provider
      value={{
        label: 'Right pane',
        tabs: [
          { id: 'compendium', label: 'Compendium' },
          { id: 'english', label: 'English' },
          { id: 'reports', label: 'Reports (3)' },
        ],
        active,
        onSelect: setActive,
      }}
    >
      <div className={styles.pane}>
        <RightPane label="Right pane" header={<RightPaneHeader title="Compendium" />}>
          <p className={styles.plain}>Showing: {active}</p>
        </RightPane>
      </div>
    </RightPaneTabsContext.Provider>
  );
}

function SegmentedDemo({ disabled = false, isLong = false }) {
  const [value, setValue] = useState<'base' | 'enhanced' | 'compare'>('base');
  return (
    <Segmented<'base' | 'enhanced' | 'compare'>
      label="Version"
      value={value}
      disabled={disabled}
      onChange={setValue}
      options={[
        { value: 'base', label: isLong ? 'Grundversion' : 'Base' },
        { value: 'enhanced', label: isLong ? 'Verbesserte Version' : 'Enhanced' },
        { value: 'compare', label: isLong ? 'Vergleichen' : 'Compare' },
      ]}
    />
  );
}

function SourceDemo() {
  const [value, setValue] = useState<'current' | 'upcoming'>('upcoming');
  return (
    <Segmented<'current' | 'upcoming'>
      label="Preview source"
      value={value}
      onChange={setValue}
      options={[
        { value: 'current', label: 'Current' },
        { value: 'upcoming', label: 'Upcoming', tone: 'future' },
      ]}
    />
  );
}

function DividerDemo() {
  const handle = usePaneDivider({
    storeKey: 'gallery:demo',
    sizes: 'start',
    min: 80,
    max: 320,
    defaultWidth: 140,
    collapsible: true,
    persist: false,
  });
  return (
    <div
      ref={handle.containerRef}
      className={styles.split}
      style={{ gridTemplateColumns: `${handle.width}px 1rem minmax(0, 1fr)` }}
    >
      <div className={styles.splitPane}>Finder</div>
      <PaneDivider {...handle.divider} label="Resize finder and page" />
      <div className={styles.splitPane}>Page</div>
    </div>
  );
}

type ListItem = { kind: 'head'; text: string } | { kind: 'row'; text: string };
const listItems: ListItem[] = ['Auto Rifles', 'Hand Cannons', 'Sniper Rifles'].flatMap(
  (group, g) => [
    { kind: 'head' as const, text: group },
    ...Array.from({ length: 60 }, (_, i) => ({
      kind: 'row' as const,
      text: `${group.slice(0, -1)} perk ${g * 60 + i + 1}`,
    })),
  ],
);
function VirtualListDemo({ empty = false }) {
  const items = empty ? [] : listItems;
  return (
    <div className={styles.list}>
      {empty ? (
        <p className={styles.plain}>No tooltips match. Clear the filter to see every perk.</p>
      ) : (
        <VirtualList
          items={items}
          label="Perks"
          heightRem={(item) => (item.kind === 'head' ? 1.75 : 1.75)}
          itemKey={(item) => item.text}
          renderItem={(item) =>
            item.kind === 'head' ? (
              <div className={styles.listHead}>{item.text}</div>
            ) : (
              <div className={styles.listRow}>{item.text}</div>
            )
          }
          stickyFor={(item) =>
            item.kind === 'head' ? <div className={styles.listHead}>{item.text}</div> : null
          }
          groupStart={(index) => {
            for (let i = index; i >= 0; i--) if (items[i]?.kind === 'head') return i;
            return -1;
          }}
        />
      )}
    </div>
  );
}

function BoundaryDemo({ error = false }) {
  const [pending, setPending] = useState(false);
  return (
    <div className={styles.wide}>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          setPending(true);
          setTimeout(() => setPending(false), 1200);
        }}
      >
        Load for 1.2 s
      </button>
      <SkeletonBoundary pending={pending} error={error} label="Loading history…" shape="rows">
        {error ? (
          <p role="alert">Couldn't load history. Check your connection and try again.</p>
        ) : (
          <p className={styles.plain}>Loaded content.</p>
        )}
      </SkeletonBoundary>
    </div>
  );
}

function SuspenseDemo() {
  const [key, setKey] = useState(0);
  const [Late] = useState(() =>
    lazy(
      () =>
        new Promise<{ default: ComponentType }>((resolve) =>
          setTimeout(
            () => resolve({ default: () => <p className={styles.plain}>Page loaded.</p> }),
            1000,
          ),
        ),
    ),
  );
  return (
    <div className={styles.wide}>
      <button type="button" className={styles.button} onClick={() => setKey((k) => k + 1)}>
        Remount
      </button>
      <SkeletonSuspense key={key} label="Loading page…" shape="text">
        <Late />
      </SkeletonSuspense>
    </div>
  );
}

const notices: ShellNotice[] = [
  {
    id: 'data-load',
    level: 'alert',
    text: 'Cannot load editor data: the server did not answer.',
    actions: [{ label: 'Retry', onClick: () => undefined }],
    dismissible: true,
  },
  {
    id: 'draft-storage',
    level: 'warning',
    text: 'Drafts are kept in memory only: this browser blocks storage.',
    dismissible: true,
  },
  { id: 'saved', level: 'status', text: 'Saved 3 drafts.' },
];
function NoticeDemo() {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button type="button" className={styles.button} onClick={() => setShown(!shown)}>
        {shown ? 'Hide notices' : 'Show notices'}
      </button>
      {shown && <NoticeStrip notices={notices} />}
    </>
  );
}

function ScaleDemo() {
  const [value, setValue] = useState(100);
  return <ScaleControl value={value} onCommit={setValue} />;
}

// ---- Entries ----------------------------------------------------------------------------------

export const entries: readonly GalleryEntry[] = [
  ...liveEntries,
  // Controls
  {
    id: 'button',
    group: 'Controls',
    title: 'Button',
    from: 'ui/controls.scss (@include controls.button)',
    note: 'Every command button. 28px desktop, var(--tap) on touch. Hover and Tab through for hover and focus rings; hold for active.',
    states: [
      s('Default', () => (
        <Row>
          <button type="button" className={styles.button}>
            Save changes
          </button>
          <button type="button" className={`${styles.button} ${styles.primary}`}>
            Push live
          </button>
          <button type="button" className={styles.button} aria-label="Settings">
            <GearIcon className={styles.icon} />
          </button>
        </Row>
      )),
      s('Disabled', () => (
        <Row>
          <button type="button" className={styles.button} disabled>
            Save changes
          </button>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled>
            Push live
          </button>
        </Row>
      )),
      s('Loading', () => (
        <button type="button" className={styles.button} disabled aria-busy="true">
          Saving…
        </button>
      )),
      s('Long localized text', () => (
        <Row>
          <button type="button" className={styles.button}>
            {long.de}
          </button>
          <button type="button" className={styles.button}>
            {long.ru}
          </button>
        </Row>
      )),
    ],
  },
  {
    id: 'field',
    group: 'Controls',
    title: 'Text field',
    from: 'ui/controls.scss (@include controls.field)',
    note: 'Inputs and text areas. 16px text on iOS so focusing never zooms.',
    states: [
      s('Default', () => (
        <label className={styles.field}>
          GitHub account
          <input className={styles.input} defaultValue="octocat" />
        </label>
      )),
      s('Empty', () => (
        <label className={styles.field}>
          Search tooltips
          <input className={styles.input} type="search" placeholder="Name or hash" />
        </label>
      )),
      s('Disabled', () => (
        <label className={styles.field}>
          Hash
          <input className={styles.input} defaultValue="3891536761" disabled />
        </label>
      )),
      s('Error', () => (
        <label className={styles.field}>
          GitHub account
          <input className={styles.input} defaultValue="no such user" aria-invalid="true" />
          <span role="alert" className={styles.error}>
            No GitHub account is named “no such user”. Check the spelling.
          </span>
        </label>
      )),
      s('Long text', () => (
        <label className={styles.field}>
          Note
          <textarea className={styles.input} rows={3} defaultValue={`${long.pl}. ${long.ru}.`} />
        </label>
      )),
    ],
  },
  {
    id: 'select',
    group: 'Controls',
    title: 'Native select',
    from: 'ui/controls.scss (@include controls.field) on <select>',
    note: 'Short fixed choices. Use the native picker; custom lists only where rows need markup.',
    states: [
      s('Default', () => (
        <select className={styles.input} defaultValue="relative">
          <option value="relative">Relative (2 days ago)</option>
          <option value="date">Date</option>
          <option value="datetime">Date and time</option>
        </select>
      )),
      s('Disabled', () => (
        <select className={styles.input} disabled>
          <option>Deutsch</option>
        </select>
      )),
      s('Long option', () => (
        <select className={styles.input}>
          <option>{long.de}</option>
          <option>Short</option>
        </select>
      )),
    ],
  },
  {
    id: 'check',
    group: 'Controls',
    title: 'Checkbox and radio',
    from: 'native <input type="checkbox|radio">',
    note: 'Independent options (checkbox) and one-of choices in a form (radio).',
    states: [
      s('Default', () => (
        <Row>
          <label className={styles.check}>
            <input type="checkbox" defaultChecked /> Show English
          </label>
          <label className={styles.check}>
            <input type="checkbox" /> Wrap lines
          </label>
          <label className={styles.check}>
            <input type="radio" name="g-radio" defaultChecked /> Base
          </label>
          <label className={styles.check}>
            <input type="radio" name="g-radio" /> Enhanced
          </label>
        </Row>
      )),
      s('Disabled', () => (
        <label className={styles.check}>
          <input type="checkbox" disabled /> Sheet colours
        </label>
      )),
    ],
  },
  {
    id: 'segmented',
    group: 'Controls',
    title: 'Segmented',
    from: 'ui/RightPane (Segmented)',
    note: 'Every two-to-four-way switch: Base / Enhanced / Compare, Current / Upcoming, view modes. The chosen one is filled with an underline; Upcoming takes the cyan future mark.',
    covers: ['Segmented'],
    states: [
      s('Default', () => <SegmentedDemo />),
      s('Current / Upcoming', () => <SourceDemo />),
      s('Disabled', () => <SegmentedDemo disabled />),
      s('Long localized text', () => <SegmentedDemo isLong />),
    ],
  },
  {
    id: 'range',
    group: 'Controls',
    title: 'Interface scale slider',
    from: 'features/settings/SettingsContent (ScaleControl)',
    note: 'Range with its value and a reset. A drag applies on release; keys apply at once.',
    states: [s('Default', () => <ScaleDemo />)],
  },
  {
    id: 'stepper',
    group: 'Controls',
    title: 'Stepper',
    from: 'ui/stepper.scss (@include stepper.group / segment / arrow)',
    note: 'Touch: one joined group ‹ 58 of 138 › for the queue, the finder, and Review.',
    states: [
      s('Default', () => (
        <span className={styles.stepper}>
          <button type="button" aria-label="Previous">
            ‹
          </button>
          <span>58 of 138</span>
          <button type="button" aria-label="Next">
            ›
          </button>
        </span>
      )),
      s('At the end', () => (
        <span className={styles.stepper}>
          <button type="button" aria-label="Previous">
            ‹
          </button>
          <span>138 of 138</span>
          <button type="button" aria-label="Next" disabled>
            ›
          </button>
        </span>
      )),
    ],
  },
  {
    id: 'tabs',
    group: 'Controls',
    title: 'Text tabs',
    from: 'ui/tabs.scss (@include tabs.strip / tab)',
    note: 'Phones and touch: the pane switch and the preview version switch.',
    states: [
      s('Default', () => (
        <span className={styles.tabs} role="tablist" aria-label="Pane">
          <button type="button" role="tab" aria-selected="true">
            Editor
          </button>
          <button type="button" role="tab" aria-selected="false">
            Preview
          </button>
          <button type="button" role="tab" aria-selected="false" disabled>
            Compendium
          </button>
        </span>
      )),
      s('Long localized text', () => (
        <span className={styles.tabs} role="tablist" aria-label="Pane">
          <button type="button" role="tab" aria-selected="true">
            Übersetzung
          </button>
          <button type="button" role="tab" aria-selected="false">
            Vorschau
          </button>
          <button type="button" role="tab" aria-selected="false">
            Kompendium
          </button>
        </span>
      )),
    ],
  },
  {
    id: 'focus',
    group: 'Controls',
    title: 'Focus rings',
    from: 'ui/controls.scss (focus-ring, contain-focus-rings)',
    note: 'Tab through: rings sit outside a control, or inside it in a clipped row.',
    states: [
      s('Outside (default)', () => (
        <Row>
          <button type="button" className={styles.button}>
            First
          </button>
          <button type="button" className={styles.button}>
            Second
          </button>
        </Row>
      )),
      s('Contained (clipped row)', () => (
        <div className={styles.clipped}>
          <button type="button" className={styles.button}>
            First
          </button>
          <button type="button" className={styles.button}>
            Second
          </button>
        </div>
      )),
    ],
  },
  // Layout
  {
    id: 'panel-row',
    group: 'Layout',
    title: 'Panel row',
    from: 'ui/PanelRow',
    note: 'One 28px row that expands in place, pinned under the preview (history, notes).',
    covers: ['PanelRow'],
    states: [
      s('Collapsed', () => <PanelRowDemo />),
      s('Open', () => <PanelRowDemo open />),
      s('Without body', () => (
        <div className={styles.wide}>
          <PanelRow label="Associations" summary="None" />
        </div>
      )),
      s('Long localized text', () => <PanelRowDemo long />),
    ],
  },
  {
    id: 'right-pane',
    group: 'Layout',
    title: 'Right pane',
    from: 'ui/RightPane (RightPane, RightPaneHeader, RightPaneTabsContext)',
    note: "The editor's right pane: 28px header (title or pane tabs, then controls), scrolling body.",
    covers: ['RightPane', 'RightPaneHeader'],
    states: [
      s('Title and controls', () => (
        <div className={styles.pane}>
          <RightPane
            label="English"
            header={
              <RightPaneHeader title="English">
                <RawDiffToggle />
              </RightPaneHeader>
            }
          >
            <p className={styles.plain}>Body text scrolls on its own.</p>
          </RightPane>
        </div>
      )),
      s('Pane tabs', () => <PaneTabsDemo />),
      s('Busy', () => (
        <div className={styles.pane}>
          <RightPane label="Compendium" busy header={<RightPaneHeader title="Compendium" />}>
            <LoadingSkeleton label="Loading Compendium…" shape="text" />
          </RightPane>
        </div>
      )),
      s('Long title', () => (
        <div className={styles.pane}>
          <RightPane label="Long" header={<RightPaneHeader title={long.de} />}>
            <p className={styles.plain}>
              A long title is clipped (no ellipsis); phones hide the title, so this header is empty
              there.
            </p>
          </RightPane>
        </div>
      )),
    ],
  },
  {
    id: 'pane-divider',
    group: 'Layout',
    title: 'Pane divider',
    from: 'ui/PaneDivider + ui/usePaneDivider',
    note: 'The one resize handle for two panes. Drag, arrow keys, double-click to reset.',
    covers: ['PaneDivider'],
    states: [s('Default (not saved here)', () => <DividerDemo />)],
  },
  {
    id: 'virtual-list',
    group: 'Layout',
    title: 'Virtual list',
    from: 'ui/VirtualList',
    note: 'Long lists (finder, queues): bounded DOM window, sticky group header.',
    covers: ['VirtualList'],
    states: [
      s('183 rows in 3 groups', () => <VirtualListDemo />),
      s('Empty', () => <VirtualListDemo empty />),
    ],
  },
  {
    id: 'placeholder-page',
    group: 'Layout',
    title: 'Placeholder page',
    from: 'ui/PlaceholderPage',
    note: 'Not-found and not-yet-built pages only.',
    covers: ['PlaceholderPage'],
    states: [
      s('Default', () => (
        <PlaceholderPage title="Page not found">
          Choose a page from the navigation to continue.
        </PlaceholderPage>
      )),
    ],
  },
  // Overlays
  {
    id: 'popover',
    group: 'Overlays',
    title: 'Popover',
    from: 'ui/Popover',
    note: 'Small non-modal surface anchored to its trigger. Escape or a press outside closes it.',
    covers: ['Popover'],
    states: [
      s('Default', () => (
        <Popover label="Details" trigger="Details" className={styles.trigger} width={320}>
          <p className={styles.plain}>Hash 3891536761 · Weapon perk · Last saved 2 days ago.</p>
        </Popover>
      )),
      s('Opens on hover', () => (
        <Popover
          label="Definition"
          trigger="Jolt"
          openOnHover
          className={styles.trigger}
          width={280}
        >
          <p className={styles.plain}>Chains lightning to up to 3 nearby targets.</p>
        </Popover>
      )),
      s('Menu sheet (contain, flush)', () => (
        <Popover label="More" trigger="More" contain flush className={styles.trigger} width={220}>
          {(close) => (
            <div className={styles.menu}>
              <button type="button" onClick={() => close()}>
                Copy hash
              </button>
              <button type="button" onClick={() => close()}>
                Open in Compendium
              </button>
              <button type="button" onClick={() => close()}>
                {long.pl}
              </button>
            </div>
          )}
        </Popover>
      )),
    ],
  },
  {
    id: 'dialog',
    group: 'Overlays',
    title: 'Dialog',
    from: 'ui/Dialog',
    note: 'Modal: full-screen sheet on phones. Compact for a short confirm; form for a few fields.',
    covers: ['Dialog'],
    states: [
      s('Default', () => <DialogDemo variant="default" />),
      s('Compact confirm', () => <DialogDemo variant="compact" />),
      s('Form', () => <DialogDemo variant="form" title="New batch" />),
      s('Busy', () => <DialogDemo variant="default" busy opener="Open busy dialog" />),
      s('Long title', () => (
        <DialogDemo variant="default" title={long.de} opener="Open long-title dialog" />
      )),
    ],
  },
  {
    id: 'move-confirm',
    group: 'Overlays',
    title: 'Move confirm',
    from: 'features/tooltip/InactiveMoveControl (InactiveMoveConfirm)',
    note: 'The deliberate confirm: says what changes, Move only after a fresh load. Nothing saves here.',
    states: [
      s('Ready', () => <MoveConfirmDemo />),
      s('Loading', () => <MoveConfirmDemo loaded={false} />),
      s('Saving', () => <MoveConfirmDemo saving />),
      s('Error', () => (
        <MoveConfirmDemo loaded={false} error="Someone else moved a tooltip meanwhile" />
      )),
      s('Move out', () => <MoveConfirmDemo moved />),
    ],
  },
  // Feedback
  {
    id: 'skeleton',
    group: 'Feedback',
    title: 'Loading skeleton',
    from: 'ui/Skeleton (LoadingSkeleton)',
    note: 'Content-shaped placeholder; its label stays available to screen readers.',
    covers: ['LoadingSkeleton'],
    states: [
      s('Text', () => (
        <div className={styles.wide}>
          <LoadingSkeleton label="Loading preview…" shape="text" />
        </div>
      )),
      s('Rows', () => (
        <div className={styles.wide}>
          <LoadingSkeleton label="Loading queue…" shape="rows" count={4} />
        </div>
      )),
      s('Page', () => (
        <div className={styles.wide}>
          <LoadingSkeleton label="Loading page…" shape="page" />
        </div>
      )),
      s('Permissions', () => (
        <div className={styles.wide}>
          <LoadingSkeleton label="Loading permissions…" shape="permissions" count={2} />
        </div>
      )),
    ],
  },
  {
    id: 'skeleton-parts',
    group: 'Feedback',
    title: 'Skeleton parts',
    from: 'ui/Skeleton (SkeletonRegion, SkeletonLine, SkeletonBlock, SkeletonRows, SkeletonStatus)',
    note: 'Build a custom skeleton: one region, lines and blocks inside, a status for assistive tech.',
    covers: ['SkeletonRegion', 'SkeletonLine', 'SkeletonBlock', 'SkeletonRows', 'SkeletonStatus'],
    states: [
      s('Composed', () => (
        <div className={styles.wide}>
          <SkeletonStatus>Loading history…</SkeletonStatus>
          <SkeletonRegion>
            <SkeletonLine width={40} />
            <SkeletonBlock height="3rem" />
            <SkeletonRows count={2} headers={['Commit', 'Author', 'When']} />
          </SkeletonRegion>
        </div>
      )),
    ],
  },
  {
    id: 'skeleton-boundary',
    group: 'Feedback',
    title: 'Skeleton boundary and suspense',
    from: 'ui/Skeleton (SkeletonBoundary, SkeletonSuspense)',
    note: 'Wrap a request (boundary) or a lazy page (suspense); both keep the shared minimum time.',
    covers: ['SkeletonBoundary', 'SkeletonSuspense'],
    states: [
      s('Boundary', () => <BoundaryDemo />),
      s('Boundary error', () => <BoundaryDemo error />),
      s('Suspense', () => <SuspenseDemo />),
    ],
  },
  {
    id: 'notices',
    group: 'Feedback',
    title: 'Notice strip',
    from: 'features/navigation/NoticeStrip',
    note: 'Shell notices at the bottom right: alert, warning, then status (fades).',
    states: [s('Alert, warning, status', () => <NoticeDemo />)],
  },
  {
    id: 'inline-alert',
    group: 'Feedback',
    title: 'Inline alert and status',
    from: 'ui/InlineAlert (status: plain <p role="status">)',
    note: 'The one error notice: what happened in plain words, then Retry when trying again can help. Request errors go through plainError (services/httpError), so no HTTP body or JSON shows. Status lines confirm in the past tense.',
    covers: ['InlineAlert'],
    states: [
      s('Alert with retry', () => (
        <InlineAlert onRetry={() => undefined}>
          Couldn't load the page. Check your connection and retry.
        </InlineAlert>
      )),
      s('Alert, no retry', () => (
        <InlineAlert>Maintainer access is required to manage permissions.</InlineAlert>
      )),
      s('Request error, made plain', () => (
        <InlineAlert onRetry={() => undefined}>
          {plainError('Permissions HTTP 404: {"error":"Endpoint not found"}')}
        </InlineAlert>
      )),
      s('Long localized text', () => (
        <div className={styles.wide}>
          <InlineAlert onRetry={() => undefined} retryLabel="Erneut versuchen">
            {long.de}
          </InlineAlert>
        </div>
      )),
      s('Status', () => (
        <p role="status" className={styles.plain}>
          Permissions saved.
        </p>
      )),
    ],
  },
  // Text and markup
  {
    id: 'preview',
    group: 'Text and markup',
    title: 'Tooltip preview snippet',
    from: 'features/preview/TooltipPreview (MarkupSnippet)',
    note: 'Rendered markup: element tags, symbols, PvE/PvP, colours, titles. Hover a title.',
    states: [
      s('Rich markup', () => (
        <div className={styles.wide}>
          <MarkupSnippet text={markup} lang="en" globals={globals} />
        </div>
      )),
      s('Long localized text', () => (
        <div className={styles.wide}>
          <MarkupSnippet text={`${long.ru}. <arc Erschüttern />`} lang="ru" globals={globals} />
        </div>
      )),
      s('Empty', () => (
        <div className={styles.wide}>
          <MarkupSnippet text="" lang="en" globals={globals} />
        </div>
      )),
    ],
  },
  {
    id: 'glyphs',
    group: 'Text and markup',
    title: 'Markup row glyphs',
    from: 'features/editor/markupRow/EntryGlyph',
    note: 'What a markup button shows: the preview artwork, tags, and the enhanced arrow.',
    states: [
      s('Kinds', () => (
        <Row>
          <EntryGlyph glyph={{ kind: 'pve' }} />
          <EntryGlyph glyph={{ kind: 'pvp' }} />
          <EntryGlyph glyph={{ kind: 'pair' }} />
          <EntryGlyph glyph={{ kind: 'base-enhanced-pair' }} />
          <EntryGlyph glyph={{ kind: 'bold' }} />
          <EntryGlyph glyph={{ kind: 'colour', colour: 'yellow' }} />
          <EntryGlyph glyph={{ kind: 'arrow', text: '' }} />
          <EntryGlyph glyph={{ kind: 'mono', text: '<icon/>Word' }} />
        </Row>
      )),
    ],
  },
  {
    id: 'arrow',
    group: 'Text and markup',
    title: 'Enhanced arrow',
    from: 'ui/EnhancedArrow (EnhancedArrow, WithArrows)',
    note: 'The one enhanced mark. WithArrows draws stored 🡅 characters in plain text.',
    covers: ['EnhancedArrow', 'WithArrows'],
    states: [
      s('Sizes', () => (
        <Row>
          <EnhancedArrow />
          <EnhancedArrow size={16} title="Enhanced" />
          <EnhancedArrow size="1.25rem" />
        </Row>
      )),
      s('In text', () => <WithArrows text={`Reload ${ENHANCED_ARROW_CHAR} 25% to 30%`} />),
    ],
  },
  {
    id: 'when',
    group: 'Text and markup',
    title: 'Date',
    from: 'ui/When',
    note: 'Every rendered date: the user’s format and zone, ISO in the title.',
    covers: ['When'],
    states: [
      s('Date', () => <When value="2026-11-14T20:12:00Z" />),
      s('No date', () => <When value={null} />),
    ],
  },
  // Diffs
  {
    id: 'word-diff',
    group: 'Diffs',
    title: 'Word diff',
    from: 'ui/diff (WordDiff)',
    note: 'Plain text change: removed struck through, added underlined.',
    covers: ['WordDiff'],
    states: [
      s('Change', () => <WordDiff before={before} after={after} />),
      s('Empty', () => <WordDiff before="" after="" />),
      s('Long', () => <WordDiff before={`${long.de}. ${before}`} after={`${long.de}! ${after}`} />),
    ],
  },
  {
    id: 'history-diff',
    group: 'Diffs',
    title: 'Raw diff',
    from: 'features/history/HistoryWordDiff + RawDiffToggle',
    note: 'History and Review raw view. The Raw switch is remembered on this device.',
    states: [
      s('Raw markup change', () => (
        <HistoryWordDiff before={'<arc Jolt /> chains to 3 targets.'} after={markup} />
      )),
      s('Raw switch', () => <RawDiffToggle />),
    ],
  },
  // Compendium
  {
    id: 'sheet-cell',
    group: 'Compendium',
    title: 'Sheet cell',
    from: 'features/compendium/sheetSurface (SheetCell, SheetColoursToggle) + RichCell (Multiline)',
    note: "A Compendium cell; Sheet colours shows the sheet's own background (remembered).",
    states: [
      s('Cells', () => (
        <Row>
          <span className={styles.cell}>
            <SheetCell background="#274e13">
              <Multiline>{'+25% reload\n+10 handling'}</Multiline>
            </SheetCell>
          </span>
          <span className={styles.cell}>
            <SheetCell>No background</SheetCell>
          </span>
          <SheetColoursToggle />
        </Row>
      )),
      s('Toggle disabled', () => <SheetColoursToggle disabled />),
    ],
  },
  // Finder and status
  {
    id: 'finder-markers',
    group: 'Finder and status',
    title: 'Finder markers',
    from: 'features/navigation/FinderMarkers',
    note: 'Row markers in the finder: missing and outdated. Press one for its explanation.',
    states: [
      s('Missing', () => <FinderMarkers hashes={[1]} flags={1} />),
      s('Outdated', () => <FinderMarkers hashes={[1]} flags={2} />),
      s('Both', () => <FinderMarkers hashes={[1]} flags={3} />),
    ],
  },
  {
    id: 'build-dot',
    group: 'Finder and status',
    title: 'Build status dot',
    from: 'features/exports/BuildStatus (BuildDot)',
    note: 'Export build state; the label is in the title and for screen readers.',
    states: [
      s('Every state', () => (
        <Row>
          {(['live', 'warn', 'bad', 'none', 'unknown'] as const).map((state) => (
            <span key={state} className={styles.check}>
              <BuildDot state={state} /> {state}
            </span>
          ))}
        </Row>
      )),
    ],
  },
  // Icons
  {
    id: 'icons',
    group: 'Icons',
    title: 'Icons',
    from: 'features/navigation (GearIcon, BrandMark), features/archive (ArchiveIcon)',
    note: 'Inline SVG; the gear takes currentColor from its button’s class (fill: currentColor). The brand mark has a light and a dark drawing.',
    states: [
      s('Gear', () => <GearIcon className={styles.icon} />),
      s('Brand mark', () => <BrandMark />),
      s('Archive icon missing', () => <ArchiveIcon />),
      s('Enhanced arrow', () => <EnhancedArrow size={16} />),
    ],
  },
  // Snippets
  {
    id: 'snippet-list',
    group: 'Snippets',
    title: 'Snippet list',
    from: 'features/snippets/SnippetManager (SnippetFields for the form)',
    note: 'Settings → Snippets and Management → Team snippets: rows of label and markup, the form opens in place. Saves here stay local.',
    states: [
      // The manager fills its pane: each state gets a pane-width box, or its rows shrink to
      // min-content and wrap one letter per line.
      s('Default', () => <WideSnippets />),
      s('Empty', () => <WideSnippets start={[]} />),
      s('Loading', () => <WideSnippets loading />),
      s('Load error', () => (
        <WideSnippets error="Snippets could not load: Snippets are unavailable" />
      )),
      s('Conflict on save', () => <WideSnippets conflict />),
      s('Validation messages', () => (
        <div className={styles.wide}>
          <SnippetErrorsDemo />
        </div>
      )),
    ],
  },
];

function WideSnippets(props: ComponentProps<typeof SnippetListDemo>) {
  return (
    <div className={styles.wide}>
      <SnippetListDemo {...props} />
    </div>
  );
}

/** Exported ui components that deliberately have no entry, each with its reason. */
export const excluded: Readonly<Record<string, string>> = {};
