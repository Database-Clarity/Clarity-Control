import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { guidedFixture } from './guided-fixture';
import { GuidedPreview } from '../src/features/compendium/GuidedPreview';
import '../src/ui/global.scss';

window.fetch = async () => {
  throw new Error('Network disabled for synthetic preview');
};
const fixture = guidedFixture();
function Fixture() {
  const [stale, setStale] = useState(false);
  return (
    <main style={{ maxWidth: '65rem', margin: 'auto', padding: '1rem', overflowWrap: 'anywhere' }}>
      <h1>Synthetic guided proposals</h1>
      <button onClick={() => setStale(!stale)}>Toggle changed baseline</button>
      <GuidedPreview
        {...fixture}
        category={fixture.categories[0]}
        baseline={fixture.baseline + (stale ? '-changed' : '')}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
