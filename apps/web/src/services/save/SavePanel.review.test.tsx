import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveController } from './SavePanel';
import { useSaveState } from './state';
import { useAuthStore } from '../../stores/auth';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, apiUrl: 'https://api.example' };
});
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>();
  return {
    ...actual,
    useSaveState: Object.assign(
      (selector: (state: ReturnType<typeof actual.useSaveState.getState>) => unknown) =>
        selector(actual.useSaveState.getState()),
      actual.useSaveState,
    ),
  };
});
vi.mock('./SaveSummary', () => ({ SaveSummary: () => createElement('div', null, 'SUMMARY') }));
// Mirror the slot structure without <dialog>: body children first, footer after.
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement(
      'div',
      null,
      createElement('div', { 'data-body': '' }, children),
      createElement('div', { 'data-footer': '' }, footer),
    ),
}));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    useAuthStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useAuthStore.getState>) => unknown) =>
        selector(actual.useAuthStore.getState()),
      actual.useAuthStore,
    ),
  };
});

describe('SaveController review dialog', () => {
  const originalAuth = useAuthStore.getState();
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'editor' } });
    useSaveState.setState({ locked: true, review: { changes: [], submitted: {} } });
  });
  afterEach(() => {
    useAuthStore.setState(originalAuth);
    useSaveState.setState({ locked: false, review: null });
  });
  const render = () => renderToStaticMarkup(createElement(SaveController));

  it('puts Save and Cancel in the footer slot, not the body', () => {
    const html = render();
    const split = html.indexOf('data-footer');
    const footer = html.slice(split);
    expect(footer).toContain('>Save changes</button>');
    expect(footer).toContain('>Cancel; keep local drafts</button>');
    const body = html.slice(html.indexOf('data-body'), split);
    expect(body).not.toContain('Save changes');
    expect(body).not.toContain('Cancel; keep local drafts');
  });

  it('keeps the optional commit message inside a collapsed details element', () => {
    const html = render();
    expect(html).toMatch(
      /<details><summary>Add commit message<\/summary><label>Optional commit message<textarea/,
    );
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.match(/<textarea/g)).toHaveLength(1);
  });
});
