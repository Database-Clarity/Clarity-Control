// Synthetic source only. No production API or data repository is accessed.
import { createRoot } from 'react-dom/client';
import { parseCompendiumSheet } from '@clarity/core';
import { CompendiumDiff } from '../src/features/compendium/CompendiumDiff';
import { RichCell } from '../src/features/compendium/RichCell';
import { useSettingsStore } from '../src/stores/settings';
import '../src/ui/global.scss';

const source = (value: string) =>
  parseCompendiumSheet(
    `<style>.ritz .waffle .s1{text-align:center;color:#6fa8dc;font-size:11pt}.s1 b{color:#ffd966}</style><div class="ritz"><table class="waffle"><tr><td>Name</td><td>Description</td></tr><tr><td>Fixture</td><td class="s1">On activation:<br><br><b>${value}%</b> increased damage.<br>Lasts 10 seconds.</td></tr></table></div>`,
    '999',
  ).rows[0].cell;
const before = source('20');
const after = source('25');
const mode = new URLSearchParams(location.search).get('mode');
useSettingsStore
  .getState()
  .remember({ compendiumDiff: mode === 'before-after' ? 'before-after' : 'changes' });
// Stub any incidental API request; this fixture uses only in-memory synthetic cells.
window.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 960, margin: '24px auto', padding: 16 }}>
    <h2>Compendium source fidelity</h2>
    <p>Synthetic Google Sheets cell · dummy API</p>
    <h3>{mode === 'legacy' ? 'Before fix: alignment absent' : 'Centred source cell'}</h3>
    <div style={{ border: '1px solid #777', padding: 16 }}>
      <RichCell
        cell={
          mode === 'legacy'
            ? { ...after, runs: after.runs.map((run) => ({ ...run, textAlign: undefined })) }
            : after
        }
      />
    </div>
    {mode !== 'legacy' && (
      <>
        <h3>Linked sources changed</h3>
        <CompendiumDiff before={before} after={after} />
      </>
    )}
  </main>,
);
