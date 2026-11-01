import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { expect, it } from 'vitest';

const css = compile(fileURLToPath(new URL('./MatchReview.module.scss', import.meta.url))).css;
it('lets real catalog selects shrink inside narrow phone filter tracks', () => {
  const controls = css.match(/\.review input,\s*\.review select \{([^}]+)\}/)?.[1];
  expect(controls).toContain('min-width: 0;');
  expect(controls).toContain('width: 100%;');
});
it('budgets desktop panels from remaining viewport space, with phone document scrolling', () => {
  const entry = css.match(/(?:^|\n)\.entryReview \{([^}]+)\}/)?.[1];
  expect(entry).toContain('display: flex;');
  expect(entry).toContain('height: calc(100dvh - 2 * clamp(1.25rem, 4vw, 3rem));');
  expect(entry).toContain('box-sizing: border-box;');
  const workspace = css.match(/\.workspace \{([^}]+)\}/)?.[1];
  expect(workspace).toContain('flex: 1;');
  expect(workspace).toContain('min-height: 0;');
  const card = css.match(/\.card \{([^}]+)\}/)?.[1];
  expect(card).toContain('overflow: auto;');
  expect(card).not.toMatch(/(?:^|\s)height:/);
  expect(css).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.entryReview \{\s*display: block;\s*height: auto;/,
  );
});
