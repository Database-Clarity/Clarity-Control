import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { expect, it } from 'vitest';

const css = compile(fileURLToPath(new URL('./MatchReview.module.scss', import.meta.url))).css;
const layoutCss = compile(
  fileURLToPath(new URL('../navigation/Layout.module.scss', import.meta.url)),
).css;
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
it('keeps the phone review actions and overlay above the measured save dock', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 700px)'));
  expect(mobile).toMatch(/\.actionBar \{[^}]*bottom: var\(--save-dock-height,/);
  expect(mobile).toMatch(/\.overlay \{[^}]*var\(--save-dock-height,/);
  expect(mobile).toContain('calc(5rem + env(safe-area-inset-bottom, 0px))');
  expect(layoutCss).toContain('calc(5rem + env(safe-area-inset-bottom, 0px))');
});
it('keeps the mobile review sidebar compact without hiding the stepper elsewhere', () => {
  expect(layoutCss).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.reviewMode \.sidebar \.stepper[^}]*display: none;/,
  );
  expect(layoutCss.match(/(?:^|\n)\.stepper \{([^}]+)\}/)?.[1]).not.toContain('display: none');
});
