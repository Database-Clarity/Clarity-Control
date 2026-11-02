import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { EditorView } from '@codemirror/view';
import type { Tooltip } from '@clarity/core';
import { App } from '../src/App';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { createDraftStore, useDraftStore } from '../src/stores/drafts';
import { useSaveState } from '../src/services/save/state';
import '../src/ui/global.scss';

window.fetch = async () => {
  throw new Error('Network blocked by translator markup fixture');
};

const tooltip: Tooltip = {
  hash: 10,
  text: {
    en: { text: 'English source', updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'fixture' },
    fr: {
      text: 'Font sample: -> => !=\nif (a != b) => a -> b',
      updatedAt: '2026-10-27T00:00:00Z',
      updatedBy: 'fixture',
    },
  },
  associated: [],
};
const data: EditorData = {
  categories: [{ id: 'fixture', label: 'Fixture', group: 'Fixture', order: 1 }],
  items: {
    10: { hash: 10, name: 'Fixture', icon: '', categoryId: 'fixture', inGameDescription: '' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: { 10: tooltip },
    permissions: { users: {} },
    pushed: {},
  },
};
useDataStore.setState({ data, status: 'ready', load: async () => {} });
useAuthStore.setState({
  user: { id: 1, login: 'fixture', role: 'translator', languages: ['fr'] },
  loading: false,
  load: async () => {},
});
const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
drafts.setState({ hydrated: true });
useDraftStore.setState(drafts.getState());
drafts.subscribe((state) => useDraftStore.setState(state));

function editor() {
  const element = document.querySelector<HTMLElement>('.cm-editor');
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error('Editor not mounted');
  return view;
}

Object.assign(window, {
  markupFixture: {
    document: () => editor().state.doc.toString(),
    select: (anchor: number, head: number) => editor().dispatch({ selection: { anchor, head } }),
    composing: () => editor().compositionStarted,
    role: (role: 'translator' | 'editor' | 'signed-out') =>
      useAuthStore.setState({
        user:
          role === 'signed-out'
            ? null
            : role === 'translator'
              ? { id: 1, login: 'fixture', role, languages: ['fr'] }
              : { id: 2, login: 'fixture-editor', role },
      }),
    locked: (locked: boolean) => useSaveState.setState({ locked }),
  },
});

window.location.hash = '#/t/10?lang=fr';
createRoot(document.getElementById('root')!).render(
  createElement(HashRouter, null, createElement(App)),
);
