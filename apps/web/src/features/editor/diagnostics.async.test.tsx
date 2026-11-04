// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DiagnosticInput, DiagnosticResult } from './diagnosticRequest';
import { requestDiagnostics } from './diagnosticWorker';
import { validationDiagnostics } from './diagnostics';
import { useEditorDiagnostics } from './useEditorDiagnostics';

vi.mock('./diagnosticWorker', async (original) => ({
  ...(await original<typeof import('./diagnosticWorker')>()),
  hasDiagnosticWorker: () => true,
  requestDiagnostics: vi.fn(),
}));
const globals = { variables: '', titles: '' };
let host: HTMLDivElement;
let root: Root;
let pending: { input: DiagnosticInput; resolve(result: DiagnosticResult): void }[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  pending = [];
  vi.mocked(requestDiagnostics).mockImplementation(
    (input) => new Promise((resolve) => pending.push({ input, resolve })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function Consumer({ text, active = true }: { text: string; active?: boolean }) {
  const value = useEditorDiagnostics(
    { text, lang: 'en', globals, requireEnglish: true, selfHash: 10 },
    active,
  );
  return (
    <output data-pending={value.pending}>
      {value.issues.map((issue) => issue.message).join(',')}
    </output>
  );
}
const answer = async (text: string, message: string) =>
  act(async () => {
    for (const job of pending.filter((job) => job.input.text === text))
      job.resolve({
        issues: message ? [{ severity: 'warning', message, from: 0, to: text.length }] : [],
        glyphs: [],
      });
  });

it('ignores superseded status results and cancels status updates while stepping', async () => {
  await act(async () => root.render(<Consumer text="old" />));
  await act(async () => root.render(<Consumer text="current" />));
  await answer('old', 'stale');
  expect(host.textContent).not.toContain('stale');
  expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('true');
  await answer('current', 'current warning');
  expect(host.textContent).toBe('current warning');
  expect(host.querySelector('output')?.getAttribute('data-pending')).toBe('false');
  await act(async () => root.render(<Consumer text="passing" />));
  await act(async () => root.render(<Consumer text="passing" active={false} />));
  await answer('passing', 'do not commit while suspended');
  expect(host.textContent).toBe('current warning');
  await act(async () => root.render(<Consumer text="landed" />));
  await answer('landed', 'landed warning');
  expect(host.textContent).toBe('landed warning');
});

it('never applies old-document decorations or a response after the view is destroyed', async () => {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '#old', extensions: [validationDiagnostics('en', globals)] }),
  });
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '#current' } });
  await answer('#old', 'stale marker');
  expect(host.querySelector('[title*="stale marker"]')).toBeNull();
  await answer('#current', 'current marker');
  expect(host.querySelector('[title*="current marker"]')?.textContent).toBe('#current');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'after' } });
  view.destroy();
  await answer('after', 'destroyed marker');
  expect(host.querySelector('[title*="destroyed marker"]')).toBeNull();
});
