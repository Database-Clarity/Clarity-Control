// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import type { DiagnosticInput, DiagnosticResult } from './diagnosticRequest';
import { diagnosticGlobals, requestDiagnostics } from './diagnosticWorker';
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
  vi.useFakeTimers();
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
  vi.useRealTimers();
});
function Consumer({
  text,
  active = true,
  context = globals,
  hash = 10,
}: {
  text: string;
  active?: boolean;
  context?: MarkupGlobals;
  hash?: number;
}) {
  const value = useEditorDiagnostics(
    { text, lang: 'en', globals: context, requireEnglish: true, selfHash: hash },
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
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it('ignores superseded status results and cancels status updates while stepping', async () => {
  await act(async () => root.render(<Consumer text="old" />));
  await advance(0);
  await act(async () => root.render(<Consumer text="current" />));
  await advance(40);
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
  await advance(40);
  await answer('landed', 'landed warning');
  expect(host.textContent).toBe('landed warning');
});

it('never applies old-document decorations or a response after the view is destroyed', async () => {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '#old', extensions: [validationDiagnostics('en', globals)] }),
  });
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '#current' } });
  await advance(40);
  await answer('#old', 'stale marker');
  expect(host.querySelector('[title*="stale marker"]')).toBeNull();
  await answer('#current', 'current marker');
  expect(host.querySelector('[title*="current marker"]')?.textContent).toBe('#current');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'after' } });
  view.destroy();
  await answer('after', 'destroyed marker');
  expect(host.querySelector('[title*="destroyed marker"]')).toBeNull();
});

it('coalesces typing before inspecting imports and starts a newly selected document immediately', async () => {
  const variables = vi.fn(() => 'var value = 2');
  const context: MarkupGlobals = {
    get variables() {
      return variables();
    },
    titles: '',
    imports: { 42: '#missing' },
  };
  vi.mocked(requestDiagnostics).mockImplementation((input) => {
    // Exercise the real snapshot boundary; consumer renders must not reach it.
    diagnosticGlobals(input.text, input.globals);
    return new Promise((resolve) => pending.push({ input, resolve }));
  });
  await act(async () => root.render(<Consumer text="initial" context={context} />));
  expect(variables).not.toHaveBeenCalled();
  await advance(0);
  await answer('initial', 'initial warning');
  variables.mockClear();
  for (const text of ['i', 'im', 'import main from 42']) {
    await act(async () => root.render(<Consumer text={text} context={context} />));
    await advance(10);
  }
  expect(variables).not.toHaveBeenCalled();
  expect(pending.map((job) => job.input.text)).toEqual(['initial']);
  await advance(30);
  expect(pending.map((job) => job.input.text)).toEqual(['initial', 'import main from 42']);
  await answer('import main from 42', 'latest import warning');
  expect(host.textContent).toBe('latest import warning');
  await act(async () => root.render(<Consumer text="new document" hash={11} context={context} />));
  expect(host.textContent).not.toContain('latest import warning');
  await advance(0);
  await answer('new document', 'new document warning');
  expect(host.textContent).toBe('new document warning');
});

it('does not prepare diagnostics for skipped CodeMirror edits or a destroyed view', async () => {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: 'initial', extensions: [validationDiagnostics('en', globals)] }),
  });
  await advance(0);
  expect(pending.map((job) => job.input.text)).toEqual(['initial']);
  for (const text of ['intermediate', 'latest']) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    await advance(10);
  }
  expect(pending.map((job) => job.input.text)).toEqual(['initial']);
  await advance(30);
  await answer('latest', 'current marker');
  expect(host.querySelector('[title*="current marker"]')?.textContent).toBe('latest');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'destroyed' } });
  view.destroy();
  await advance(40);
  expect(pending.map((job) => job.input.text)).not.toContain('destroyed');
});
