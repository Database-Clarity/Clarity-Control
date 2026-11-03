import { createRoot } from 'react-dom/client';
import { CompendiumPanel } from '../src/features/compendium/CompendiumPanel';
import { guidedFixture } from './guided-fixture';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import { useCompendiumStore } from '../src/features/compendium/store';
import { bundleUrl } from '../src/services/bundle';
import { compendiumDataUrl } from '../src/services/compendium';
import '../src/ui/global.scss';

const f = guidedFixture(
  () => 'Precision final blows grant increased damage for 10 seconds.\nStacks up to three times.',
);
f.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
// This isolated fixture has no network write path, editor-data connection or account session.
window.fetch = async () =>
  new Response(JSON.stringify({ document: f.document, revision: 'fixture' }));
localStorage.removeItem(`clarity-review-guidance:v1:${encodeURIComponent(f.document.scope)}`);
useAuthStore.setState({ user: { id: 'fixture', login: 'QA', role: 'maintainer' } });
useDataStore.setState({ data: f.editor });
useDraftStore.setState({ drafts: {}, hydrated: true });
useCompendiumStore.setState({ data: f.source, loading: false, error: null, load: async () => {} });
const base = f.categories[0].entries.find((entry) => entry.hash === 100)!.base;
createRoot(document.getElementById('root')!).render(
  <main
    style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
      maxWidth: '36rem',
      height: '100dvh',
      marginLeft: 'auto',
    }}
  >
    <CompendiumPanel base={base} />
  </main>,
);
