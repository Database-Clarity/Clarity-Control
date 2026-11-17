import { useState, type ComponentProps, type CSSProperties } from 'react';
import {
  compareDiffOutput,
  presentDiff,
  renderedDiff,
  variantGlobals,
} from '../history/renderedDiff';
import { RenderedWordDiffView } from '../history/RenderedWordDiff';
import { StatusBarView, type StatusPanel } from '../editor/StatusBar';
import { SuggestChipView } from '../editor/markupRow/SuggestChip';
import { SuggestMenuView } from '../editor/suggest/SuggestMenu';
import { FinderOptionView } from '../navigation/TooltipNavigation';
import { FinderPickerView } from '../navigation/FinderPicker';
import { FinderMarkersView, ScheduledMarkerView } from '../navigation/FinderMarkers';
import { FinderIcon } from '../navigation/FinderIcon';
import { WorkspaceTabsView } from '../navigation/WorkspaceTabs';
import { workspaceMenu } from '../navigation/links';
import { WorklistPickerView, DraftWorklistsView } from '../queue/WorklistsMenu';
import { BatchRowView } from '../review/batches/BatchesPane';
import { VersionSwitch } from '../preview/PreviewColumn';
import { CompendiumDiffView } from '../compendium/CompendiumDiff';
import type { GalleryEntry } from './entries';
import picker from '../navigation/TooltipFinder.module.scss';
import worklists from '../queue/WorklistsMenu.module.scss';
import batches from '../review/batches/Batches.module.scss';
import styles from './Gallery.module.scss';

const noop = () => {};
const long = 'Änderungen an allen ausgewählten Übersetzungen speichern und veröffentlichen';
const globals = { variables: '', titles: '' };
const before = 'Final blows grant <arc +20% /> damage for 5 seconds.';
const after = 'Final blows grant <arc +25% /> damage for 6 seconds.';
const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
const state = (label: string, View: () => React.JSX.Element) => ({
  label,
  View: () => (
    <div className={styles.liveFixture}>
      <View />
    </div>
  ),
});

function StatusDemo({ kind }: { kind: string }) {
  const [panel, onPanel] = useState<StatusPanel | null>(null);
  const [rawView, raw] = useState(false);
  return (
    <StatusBarView
      readOnlyReason={kind === 'Read only' ? long : null}
      issues={
        kind === 'Warnings'
          ? ([{ severity: 'error', message: 'Unclosed markup', from: 0, to: 1 }] as ComponentProps<
              typeof StatusBarView
            >['issues'])
          : []
      }
      validating={kind === 'Validating'}
      glyphCount={kind === 'Warnings' ? 3 : 0}
      retiredCount={kind === 'Warnings' ? 2 : 0}
      parityCount={kind === 'Warnings' ? 4 : 0}
      terms={
        kind === 'Terms loading'
          ? { count: 0, loading: true }
          : kind === 'Warnings'
            ? { count: 8, loading: false, missing: 2 }
            : undefined
      }
      line={12}
      column={36}
      changes={kind === 'Unsaved'}
      panel={panel}
      onPanel={onPanel}
      unpreviewed={kind === 'Preview waiting' ? 3 : 0}
      reserveKey="fixture"
      preview={
        kind.startsWith('Preview')
          ? { collapsed: kind === 'Preview hidden', onShow: noop }
          : undefined
      }
      conflicts={kind === 'Warnings' ? { count: 2, onNext: noop } : undefined}
      rawView={rawView}
      onRawView={() => raw(!rawView)}
      onSuggest={noop}
    />
  );
}

function FinderDemo({ kind }: { kind: string }) {
  const [current, select] = useState(false);
  const [active, highlight] = useState(false);
  return (
    <ul
      className={picker.listbox}
      role="listbox"
      aria-label="Fixture tooltips"
      style={{ padding: 0, margin: 0 }}
    >
      <FinderOptionView
        id={`fixture-${kind}`}
        index={0}
        total={1}
        current={current || kind === 'Current'}
        active={active || kind === 'Active'}
        virtual={false}
        rowHeight={36}
        twoLine={kind === 'Grouped'}
        stacked={kind === 'Grouped'}
        narrow={kind === 'Narrow'}
        grouped={kind === 'Grouped' ? 'armor' : undefined}
        global={kind === 'Global'}
        allCategories
        enhanced={kind === 'Enhanced'}
        name={
          kind === 'Long' ? long : kind === 'Global' ? 'Weapon damage variables' : 'Chaos Reshaped'
        }
        category="Weapon perks"
        perk="Damage"
        tail="Raid · shared perk"
        onActive={() => highlight(true)}
        onCommit={() => select(!current)}
        icon={<FinderIcon />}
        markers={
          <FinderMarkersView
            flags={kind === 'Markers' ? 3 : 0}
            unsaved={kind === 'Markers' || kind === 'Unsaved'}
            scheduled={
              <ScheduledMarkerView
                state={
                  kind === 'Scheduled'
                    ? 'scheduled'
                    : kind === 'Preparing'
                      ? 'preparing'
                      : kind === 'Needs attention'
                        ? 'needs_attention'
                        : null
                }
              />
            }
          />
        }
      />
    </ul>
  );
}
function PickerDemo({ kind }: { kind: string }) {
  const [value, change] = useState('arc');
  const options = [
    { id: 'arc', label: 'Arc' },
    { id: 'solar', label: kind === 'Long' ? long : 'Solar' },
    { id: 'void', label: 'Void' },
  ];
  return (
    <FinderPickerView
      label="Damage type"
      value={value}
      onChange={change}
      disabled={kind === 'Disabled'}
      empty="No categories"
      icons={kind === 'Icons'}
      columns={kind === 'Columns'}
      sections={
        kind === 'Empty'
          ? []
          : kind === 'Sections' || kind === 'Columns'
            ? [
                { label: 'Light', options },
                {
                  label: 'Darkness',
                  options: [
                    { id: 'stasis', label: 'Stasis' },
                    { id: 'strand', label: 'Strand' },
                  ],
                },
              ]
            : [{ options }]
      }
      renderMarkers={() => kind === 'Markers' && <FinderMarkersView flags={3} unsaved />}
    />
  );
}
function VersionDemo({ enhanced = true }: { enhanced?: boolean }) {
  const [value, set] = useState<ComponentProps<typeof VersionSwitch>['value']>('base');
  return (
    <VersionSwitch label="Preview version" value={value} hasEnhanced={enhanced} onChange={set} />
  );
}
function DiffDemo({ kind }: { kind: string }) {
  const a =
    kind === 'Enhanced'
      ? 'Base damage.\nenhanced (\nEnhanced damage 20%.\n)'
      : kind === 'Insertion'
        ? ''
        : kind === 'Folded'
          ? Array(14).fill(before).join('\n')
          : before;
  const b =
    kind === 'Enhanced'
      ? 'Base damage.\nenhanced (\nEnhanced damage 25%.\n)'
      : kind === 'Deletion'
        ? ''
        : kind === 'Unchanged'
          ? a
          : kind === 'Folded'
            ? `${a}\n${after}`
            : after;
  const result = {
    ...presentDiff(renderedDiff(a, b, globals)),
    output: compareDiffOutput(a, b, globals),
    enhanced:
      kind === 'Enhanced'
        ? presentDiff(renderedDiff(a, b, variantGlobals(globals, true)))
        : undefined,
  };
  return (
    <RenderedWordDiffView
      before={a}
      after={b}
      lang="en"
      hash={1}
      responsive
      result={result}
      busy={kind === 'Loading'}
      sourceUnavailable={kind === 'Unavailable'}
      sourceAnalysis={undefined}
    />
  );
}
function ChipDemo({ tab = false }: { tab?: boolean }) {
  const [shown, show] = useState(true);
  return shown ? (
    <SuggestChipView
      chip={{ markup: '<arc/>', text: 'Insert Arc symbol' }}
      acceptKey={tab ? 'tab' : 'enter'}
      style={{ position: 'relative', top: 0, left: 0 }}
      onAccept={() => show(false)}
      onDismiss={() => show(false)}
    />
  ) : (
    <button type="button" onClick={() => show(true)}>
      Show suggestion
    </button>
  );
}
function SuggestDemo({ kind }: { kind: string }) {
  const [index, move] = useState(0);
  const [closed, close] = useState(false);
  const items: ComponentProps<typeof SuggestMenuView>['snapshot']['items'] = [
    'Arc',
    'Solar',
    'Void',
  ].map((label, i) => ({
    id: label,
    category: 'Symbols',
    label: kind === 'Long' ? long : label,
    about: 'Insert an element symbol.',
    from: 0,
    to: 0,
    insert: `<${label.toLowerCase()}/>`,
    stops: [],
    preview: `<${label.toLowerCase()}/>`,
    keys: label,
    unavailable: kind === 'Unavailable' && i === 0 ? 'Cannot go inside this markup.' : undefined,
  }));
  const rows = items.map((item, i) => ({
    kind: 'option' as const,
    text: item.label,
    index: i,
    options: i,
    headings: 0,
  }));
  if (closed)
    return (
      <button type="button" onClick={() => close(false)}>
        Open suggestions
      </button>
    );
  return (
    <SuggestMenuView
      style={{ position: 'relative', top: 0, left: 0, '--menu-max': '340px' } as CSSProperties}
      snapshot={{
        items,
        index,
        context: {
          kind: 'word',
          from: 0,
          to: 0,
          query: '',
          selection: '',
          lineFrom: 0,
          lineText: '',
          definitions: '',
          lineIsFree: true,
        },
        explicit: true,
        message: kind === 'Rejected' ? 'Cannot insert here.' : null,
        judged: true,
        picked: true,
        aside: kind === 'Aside' ? '2 of 4 in the translation' : undefined,
      }}
      selected={items[index]}
      drawn={rows}
      last={rows[2]}
      above={rows[0]}
      start={0}
      end={3}
      short={kind === 'Short'}
      pairGlobals={null}
      note={kind === 'Rejected' ? 'Cannot insert here.' : items[index].unavailable}
      previewText={kind === 'No preview' ? null : items[index].preview}
      lang="en"
      globals={globals}
      used={kind === 'Unused' ? 0 : 12}
      onMove={move}
      onAccept={() => close(true)}
      onClose={() => close(true)}
    />
  );
}
function WorklistDemo({ kind }: { kind: string }) {
  const [creating, create] = useState(kind === 'Create');
  const [name, setName] = useState('');
  return (
    <WorklistPickerView
      itemCount={3}
      lists={
        kind === 'Empty'
          ? []
          : [
              {
                id: 'raid',
                name: kind === 'Long' ? long : 'Raid perks',
                count: 12,
                saving: kind === 'Saving',
              },
            ]
      }
      name={name}
      creating={creating}
      busy={kind === 'Saving'}
      error={kind === 'Error' ? 'Could not add entries.' : ''}
      onCreate={() => create(true)}
      onName={setName}
      onSave={noop}
      onCancel={() => create(false)}
    />
  );
}

export const liveEntries: GalleryEntry[] = [
  {
    id: 'finder-row',
    group: 'Finder',
    title: 'Finder row',
    from: 'features/navigation/TooltipNavigation (FinderOptionView)',
    note: 'Prepared finder row; icon and marker slots preserve the fixed marker column.',
    states: [
      'Default',
      'Current',
      'Active',
      'Enhanced',
      'Grouped',
      'Narrow',
      'Global',
      'Markers',
      'Unsaved',
      'Scheduled',
      'Preparing',
      'Needs attention',
      'Long',
    ].map((kind) =>
      state(kind, () => (
        <div className={styles.liveWide}>
          <FinderDemo kind={kind} />
        </div>
      )),
    ),
  },
  {
    id: 'finder-picker',
    group: 'Finder',
    title: 'Custom select',
    from: 'features/navigation/FinderPicker (FinderPickerView)',
    note: 'Open with Enter or arrows; browse, type to jump, choose, or Escape.',
    states: ['Default', 'Disabled', 'Empty', 'Icons', 'Sections', 'Columns', 'Markers', 'Long'].map(
      (kind) => state(kind, () => <PickerDemo kind={kind} />),
    ),
  },
  {
    id: 'status-bar',
    group: 'Editor',
    title: 'Status bar',
    from: 'features/editor/StatusBar (StatusBarView)',
    note: 'Prepared warning counts and panel events; number status is a slot.',
    states: [
      'Idle',
      'Read only',
      'Warnings',
      'Validating',
      'Unsaved',
      'Terms loading',
      'Preview waiting',
      'Preview hidden',
    ].map((kind) =>
      state(kind, () => (
        <div className={styles.liveWide}>
          <StatusDemo kind={kind} />
        </div>
      )),
    ),
  },
  {
    id: 'rendered-diff',
    group: 'Diffs',
    title: 'Rendered word diff',
    from: 'features/history/RenderedWordDiff (RenderedWordDiffView)',
    note: 'Prepared renderer output; no live tooltip or worker subscription.',
    states: [
      'Changed',
      'Unchanged',
      'Insertion',
      'Deletion',
      'Folded',
      'Enhanced',
      'Loading',
      'Unavailable',
    ].map((kind) => state(kind, () => <DiffDemo kind={kind} />)),
  },
  {
    id: 'workspace-tabs',
    group: 'Navigation',
    title: 'Workspace tabs',
    from: 'features/navigation/WorkspaceTabs (WorkspaceTabsView)',
    note: 'Role and responsive menu choices are supplied by the host; More retains keyboard navigation.',
    states: ['maintainer', 'editor', 'translator', 'viewer'].map((role) =>
      state(role, () => (
        <WorkspaceTabsView
          {...workspaceMenu({ role: role as 'maintainer' })}
          current="/review"
          pathname="/review"
          routeFor={(to) => to}
        />
      )),
    ),
  },
  {
    id: 'suggest-chip',
    group: 'Editor',
    title: 'Suggestion chip',
    from: 'features/editor/markupRow/SuggestChip (SuggestChipView)',
    note: 'Editor placement and accept/dismiss commands stay in the wrapper.',
    states: [state('Enter', () => <ChipDemo />), state('Tab', () => <ChipDemo tab />)],
  },
  {
    id: 'suggest-menu',
    group: 'Editor',
    title: 'Suggestion menu',
    from: 'features/editor/suggest/SuggestMenu (SuggestMenuView)',
    note: 'Prepared virtual rows and preview; choose, accept, and close emit events.',
    states: [
      'Default',
      'Unavailable',
      'Rejected',
      'Aside',
      'No preview',
      'Unused',
      'Short',
      'Long',
    ].map((kind) =>
      state(kind, () => (
        <div className={styles.liveWide}>
          <SuggestDemo kind={kind} />
        </div>
      )),
    ),
  },
  {
    id: 'batch-row',
    group: 'Review',
    title: 'Batch row',
    from: 'features/review/batches/BatchesPane (BatchRowView)',
    note: 'Prepared status, counts, time, and destination; no batch subscription.',
    states: [
      'Open',
      'Selected',
      'Scheduled',
      'Preparing',
      'Needs attention',
      'Published',
      'Long',
    ].map((kind, i) =>
      state(kind, () => (
        <ul className={batches.list}>
          <BatchRowView
            id={kind}
            name={kind === 'Long' ? long : 'Sandbox weapon changes'}
            selected={i === 1}
            search="?view=batches"
            chip={{ label: kind, tone: i === 4 ? 'bad' : 'neutral' }}
            when={i === 0 ? 'No time set' : '17 Nov 2026, 12:00 CET'}
            facts={['3 tooltips', '1 stale', '2 conflicts', 'translations 4/6']}
          />
        </ul>
      )),
    ),
  },
  {
    id: 'worklists',
    group: 'Navigation',
    title: 'Worklists picker',
    from: 'features/queue/WorklistsMenu (WorklistPickerView, DraftWorklistsView)',
    note: 'Fixture choices and creation form emit events; no sync or save calls.',
    states: ['Default', 'Create', 'Empty', 'Saving', 'Error', 'Long']
      .map((kind) => state(kind, () => <WorklistDemo kind={kind} />))
      .concat([
        state('Drafts loading', () => (
          <div className={worklists.content}>
            <DraftWorklistsView drafts={null} onOpen={noop} />
          </div>
        )),
        state('Drafts empty', () => (
          <div className={worklists.content}>
            <DraftWorklistsView drafts={[]} onOpen={noop} />
          </div>
        )),
      ]),
  },
  {
    id: 'version-switch',
    group: 'Preview',
    title: 'Version switch',
    from: 'features/preview/PreviewColumn (VersionSwitch)',
    note: 'Already props-only; the app and gallery share this exact control.',
    states: [
      state('Base, Enhanced, Compare', () => <VersionDemo />),
      state('No enhanced version', () => <VersionDemo enhanced={false} />),
    ],
  },
  {
    id: 'compendium-diff',
    group: 'Diffs',
    title: 'Compendium diff',
    from: 'features/compendium/CompendiumDiff (CompendiumDiffView)',
    note: 'Explicit mode and change callback; remembered device mode remains outside.',
    states: ['Changes', 'Before and after', 'Unchanged', 'Style', 'Empty'].map((kind) =>
      state(kind, () => (
        <CompendiumDiffView
          before={cell(kind === 'Empty' ? '' : 'Damage increased by 20%.')}
          after={
            kind === 'Style'
              ? {
                  plain: 'Damage increased by 20%.',
                  runs: [{ text: 'Damage increased by 20%.', bold: true }],
                }
              : cell(
                  kind === 'Empty'
                    ? ''
                    : kind === 'Unchanged'
                      ? 'Damage increased by 20%.'
                      : 'Damage increased by 25%.',
                )
          }
          mode={kind === 'Before and after' ? 'before-after' : 'changes'}
        />
      )),
    ),
  },
];
