import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { MarkupGlobals, Tooltip } from '@clarity/core';
import { ClarityEditor } from '../src/features/editor/ClarityEditor';
import { tooltipTextSources } from '../src/features/editor/references';
import '../src/ui/global.scss';

// Synthetic data only; the tooltip store below stands in for the real one.
const tooltip = (hash: number, en: string) =>
  ({ hash, text: { en: { text: en, updatedAt: 'x' } } }) as unknown as Tooltip;
const store = {
  '2': tooltip(2, 'var damage = <blue 25 />\nvar duration = 10 seconds\nvar noted = empty'),
  '3': tooltip(3, 'title Details (\n<yellow Stacks up to 5 times. />\nResets on reload.\n)'),
  '42': tooltip(
    42,
    'Main text\n\nexport Perk (\nDeals #damage for #duration.\n<pve PvE only />\n)',
  ),
};
const globals: MarkupGlobals = {
  variables: store['2'].text.en!.text,
  titles: store['3'].text.en!.text,
  imports: {
    '2': store['2'].text.en!.text,
    '3': store['3'].text.en!.text,
    '42': store['42'].text.en!.text,
  },
};
const sources = tooltipTextSources(store, {}, {});

function Fixture() {
  const [value, setValue] = useState(
    [
      'Synthetic tooltip — no production data',
      'var local = <purple Local value />',
      '',
      'Deals #damage for #duration, plus #local and #missing.',
      '<title Hover for details [Details] />',
      'import Perk from 42',
    ].join('\n'),
  );
  const [log, setLog] = useState('');
  return (
    <main style={{ maxWidth: 720, margin: '60px auto', padding: 12 }}>
      <ClarityEditor
        value={value}
        lang="en"
        globals={globals}
        tooltipHash={99}
        referenceSources={sources}
        onOpenTooltip={(target) => setLog(JSON.stringify(target))}
        onChange={setValue}
      />
      <pre id="navigated">{log}</pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
