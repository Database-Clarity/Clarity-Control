import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ClarityEditor } from '../src/features/editor/ClarityEditor';
import { validateText } from '@clarity/core';
import '../src/ui/global.scss';
window.fetch = async () =>
  new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
function Fixture() {
  const [value, setValue] = useState(
    'Synthetic tooltip — no production data\n\n• Damage increases 20% 🠚 30% for 5 seconds.\n• Enhanced marker: 🡅\n• Unverified symbol: ▛\n• Safe text: Café × 2, 90°, “quoted” …',
  );
  return (
    <main style={{ maxWidth: 850, margin: '30px auto', padding: 12 }}>
      <h1>Character display warnings</h1>
      <p>Synthetic fixture · dummy API · edits stay in this page</p>
      <ClarityEditor
        value={value}
        lang="en"
        globals={{ variables: '', titles: '' }}
        onChange={setValue}
      />
      <details>
        <summary>Save review warnings (saving allowed)</summary>
        <ul>
          {validateText(value, 'en').map((w, i) => (
            <li key={i}>
              {w.severity}: {w.message}
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
