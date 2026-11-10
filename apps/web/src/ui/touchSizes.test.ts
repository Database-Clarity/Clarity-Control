import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The phone UI is compact by default (owner 2026-11-10): every touch size on these screens reads
// the tokens (--tap 36px, --tap-sm 28px, both 44px with Large), so no 44px literal or text floor
// may come back. A desktop default keeps 44px only as the token's fallback, var(--tap, ...).
const files = [
  '../features/editor/markupRow/MarkupRow.module.scss',
  '../features/editor/markupRow/SuggestChip.module.scss',
  '../features/editor/StatusBar.module.scss',
  '../features/editor/help/MarkupHelp.module.scss',
  '../features/editor/ClarityEditor.module.scss',
  '../features/editor/RetiredPanel.module.scss',
  '../features/editor/suggest/SuggestMenu.module.scss',
  '../features/compendium/Compendium.module.scss',
  '../features/compendium/CompendiumTab.module.scss',
  '../features/compendium/CompendiumQueue.module.scss',
  '../features/compendium/MatchReview.module.scss',
  '../features/compendium/PickerStage.module.scss',
  '../features/lost-text/LostText.module.scss',
  '../features/drift/Status.module.scss',
  '../features/archive/ArchivePage.module.scss',
  '../features/history/History.module.scss',
  '../features/conflicts/CompareView.module.scss',
  '../features/tooltip/EditorMore.module.scss',
  './Dialog.module.scss',
];
const code = (file: string) =>
  readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    // The desktop fallback of a token is allowed: var(--tap, max(44px, 2.75rem)).
    .map((line) => line.replace(/var\(--tap(-sm)?, max\(44px, 2\.75rem\)\)/g, 'var(--tap)'));

/** The lines inside a touch block (mobile, coarse pointer, or both), outside the iOS-only query. */
function touchLines(file: string) {
  const stack: string[] = [];
  const lines: string[] = [];
  for (const line of code(file)) {
    const touch = stack.some((open) => /mobile|coarse|max-width: 700px/.test(open));
    const ios = stack.some((open) => open.includes('-webkit-touch-callout'));
    if (touch && !ios) lines.push(line);
    for (const [index, char] of [...line].entries()) {
      if (char === '{') stack.push(line.slice(0, index));
      else if (char === '}') stack.pop();
    }
  }
  return lines;
}

describe('touch sizes read the tokens', () => {
  it.each(files)('%s has no 44px size and no 16px text floor in touch blocks', (file) => {
    const offending = touchLines(file).filter(
      (line) =>
        /\b44px\b|(?:height|width):\s*2\.75rem/.test(line) ||
        /font-size:\s*(max\(1[4-6]px|1[4-6]px)/.test(line),
    );
    expect(offending).toEqual([]);
  });

  it('keeps the iOS 16px floor only behind the iOS feature query', () => {
    const editor = code('../features/editor/ClarityEditor.module.scss').join('\n');
    const floors = [...editor.matchAll(/max\(16px/g)].map((match) => match.index!);
    expect(floors.length).toBeGreaterThan(0);
    for (const at of floors)
      expect(editor.lastIndexOf('@supports (-webkit-touch-callout: none)', at)).toBeGreaterThan(
        editor.lastIndexOf('}', at - 200),
      );
  });

  it('compact follows the interface scale; Large keeps its 44px floor', () => {
    const tokens = code('./tokens.scss').join('\n');
    expect(tokens).toMatch(/--tap: 2\.25rem;/);
    expect(tokens).toMatch(/--tap-sm: 1\.75rem;/);
    expect(tokens).toMatch(/\[data-touch='large'\] \{\s*--tap: max\(44px, 2\.75rem\);/);
  });
});
