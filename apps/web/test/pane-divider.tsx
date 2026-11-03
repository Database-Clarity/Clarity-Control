import { createRoot } from 'react-dom/client';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router-dom';
import { PaneDivider } from '../src/ui/PaneDivider';
import { usePaneDivider } from '../src/ui/usePaneDivider';
import { PreviewLeaveGuard } from '../src/features/navigation/PreviewLeaveGuard';
import { reviewKey, usePreviewReviewStore } from '../src/stores/previewReview';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import { watchSystemTheme } from '../src/ui/theme';
import { useSettingsStore } from '../src/stores/settings';
import '../src/ui/global.scss';

window.fetch = async () => {
  throw new Error('Network blocked by pane divider fixture');
};
watchSystemTheme(() => useSettingsStore.getState().device.theme);

const rows = ['Sample tooltip', 'Another tooltip', 'Third tooltip', 'Fourth tooltip', 'Fifth one'];

const pane = {
  boxSizing: 'border-box',
  minWidth: 0,
  padding: 12,
  overflow: 'hidden',
  font: '13px/20px system-ui, sans-serif',
  color: 'var(--text)',
} as const;

// The shell's two pairs: left column | main, and inside main editor | right pane.
function Bench() {
  const left = usePaneDivider({
    storeKey: 'editor:left',
    sizes: 'start',
    min: 280,
    max: 480,
    defaultWidth: (container) => (container > 0 && container < 1300 ? 304 : 336),
    reserve: 480,
    collapsible: true,
  });
  const right = usePaneDivider({
    storeKey: 'editor:right',
    sizes: 'end',
    min: 320,
    max: 640,
    defaultWidth: 384,
    reserve: 480,
  });
  return (
    <div
      ref={left.containerRef}
      data-testid="bench"
      style={{
        display: 'grid',
        gridTemplateColumns: `${left.width}px 16px minmax(0, 1fr)`,
        height: 420,
        margin: '24px 16px',
        background: 'var(--page)',
        border: '1px solid var(--line)',
      }}
    >
      <section
        aria-label="Left column"
        data-pane="left"
        style={{ ...pane, background: 'var(--col)' }}
      >
        <strong>Left column</strong>
        {rows.map((row) => (
          <div key={row} style={{ borderBottom: '1px solid var(--hair)', padding: '2px 0' }}>
            {row}
          </div>
        ))}
      </section>
      <PaneDivider {...left.divider} label="Resize left column" />
      <div
        ref={right.containerRef}
        data-pane="main"
        style={{
          display: 'grid',
          gridTemplateColumns: `minmax(0, 1fr) 16px ${right.width}px`,
          minWidth: 0,
        }}
      >
        <section
          aria-label="Editor"
          data-pane="editor"
          style={{
            ...pane,
            background: 'var(--editor)',
            color: 'var(--editor-text)',
            fontFamily: 'monospace',
          }}
        >
          <strong>Editor</strong>
          <div>Line one of the description</div>
          <div>
            Line two {'{'}variable{'}'}
          </div>
        </section>
        <PaneDivider {...right.divider} label="Resize editor and Compendium" />
        <section
          aria-label="Compendium"
          data-pane="right"
          style={{ ...pane, background: 'var(--col)' }}
        >
          <strong>Compendium</strong>
          <div>Source text for the item</div>
        </section>
      </div>
    </div>
  );
}

// The leave guard over a real data router, with one unreviewed change.
const data = {
  items: {
    10: { hash: 10, name: 'Demolitionist', categoryId: 'a', icon: '', inGameDescription: '' },
  },
  aliases: {},
  categories: [],
  bundle: { tooltips: {}, sourceCommit: 'fixture' },
} as unknown as EditorData;

function GuardScene() {
  return (
    <>
      <PreviewLeaveGuard />
      <nav style={{ padding: 16, font: '13px system-ui' }}>
        <Link to="/review">Review changes</Link>
      </nav>
      <Outlet />
    </>
  );
}

const root = document.getElementById('root')!;
const scene = new URLSearchParams(location.search).get('scene');
if (scene === 'guard') {
  localStorage.setItem(
    reviewKey('anonymous'),
    JSON.stringify({ 10: { canonical: 10, dirty: 1, reviewed: 0 } }),
  );
  useDataStore.setState({ data, status: 'ready' });
  useDraftStore.setState({ hydrated: true, drafts: {}, owner: null });
  usePreviewReviewStore.getState().registerHost({ show() {} });
  const router = createMemoryRouter(
    [
      {
        element: <GuardScene />,
        children: [
          { path: '/t/:hash', element: <p style={{ padding: 16 }}>Editing Demolitionist</p> },
          { path: '/review', element: <p>Review</p> },
        ],
      },
    ],
    { initialEntries: ['/t/10'] },
  );
  Object.assign(window, { fixture: { router } });
  createRoot(root).render(<RouterProvider router={router} />);
} else {
  createRoot(root).render(<Bench />);
}
