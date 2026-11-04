import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
// Every styled cell and tooltip proof participates. Transport/account/publication metadata
// cannot change pristine decisions; local guidance still gates against the current commit.
export function matchingInputs(editor: EditorData, source: CompendiumData) {
  return [editor.categories, editor.items, editor.aliases, editor.bundle.tooltips, source.tabs];
}
