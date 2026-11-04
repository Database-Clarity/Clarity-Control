import { createRoot } from 'react-dom/client';
import { HistoryPanel } from '../src/features/history/HistoryPanel';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useAuthStore } from '../src/stores/auth';
import { useDraftStore } from '../src/stores/drafts';
import { legacyHistorySchema, legacyTooltip } from '../src/services/legacyHistory';
import '../src/ui/global.scss';

// The QA server supplies an unchanged generated real published artifact.
const history = legacyHistorySchema.parse(await (await fetch('/fixture.json')).json());
const lane = history.lanes.find((lane) => lane.verified)!;
const current = legacyTooltip(
  history.hash,
  [...lane.revisions].reverse().find((revision) => revision.text !== null)!,
)!;
useDataStore.setState({
  data: {
    bundle: { tooltips: { [history.hash]: current } },
    items: {},
    aliases: {},
    categories: [],
  } as unknown as EditorData,
  status: 'ready',
});
useAuthStore.setState({ user: { id: 1, login: 'qa', role: 'editor' }, loading: false });
useDraftStore.setState({ drafts: {}, hydrated: true });
createRoot(document.getElementById('root')!).render(
  <main style={{ width: 'min(300px, 100%)', padding: 8, boxSizing: 'border-box' }}>
    <HistoryPanel hash={history.hash} />
  </main>,
);
