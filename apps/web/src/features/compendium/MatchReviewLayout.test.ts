import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { expect, it } from 'vitest';

const css = compile(fileURLToPath(new URL('./MatchReview.module.scss', import.meta.url))).css;
const layoutCss = compile(
  fileURLToPath(new URL('../navigation/Layout.module.scss', import.meta.url)),
).css;
const categoryCss = compile(
  fileURLToPath(new URL('./CategoryReview.module.scss', import.meta.url)),
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
it('bounds the mobile context-aware sidebar without hiding the Editor stepper globally', () => {
  expect(layoutCss).toMatch(/\.sidebar\[data-open=true\] \{[^}]*height: 100dvh;/);
  expect(layoutCss).toMatch(/\.sidebar\[data-open=true\] \.sidebarBody \{[^}]*overflow-y: auto;/);
  expect(layoutCss.match(/(?:^|\n)\.stepper \{([^}]+)\}/)?.[1]).not.toContain('display: none');
});
it('gives category and pending queue links 44px phone/coarse targets without changing desktop density', () => {
  const desktop = layoutCss.match(/(?:^|\n)\.sidebarNavigation a \{([^}]+)\}/)?.[1];
  expect(desktop).toContain('padding: 0.35rem 0;');
  expect(desktop).not.toContain('min-height');
  for (const media of ['(max-width: 700px)', '(pointer: coarse)']) {
    const targets = layoutCss.match(
      new RegExp(
        `@media ${media.replace(/[()]/g, '\\$&')} \\{\\s*\\.sidebarNavigation a \\{([^}]+)\\}`,
      ),
    )?.[1];
    expect(targets).toContain('min-height: 44px;');
    expect(targets).toContain('box-sizing: border-box;');
    expect(targets).toContain('align-items: center;');
  }
});
it('applies the category viewport budget to the route itself, with internal overflow and phone scrolling', () => {
  const category = css.match(/(?:^|\n)\.categoryReview \{([^}]+)\}/)?.[1];
  expect(category).toContain('display: flex;');
  expect(category).toContain('height: calc(100dvh - 2 * clamp(1.25rem, 4vw, 3rem));');
  expect(category).toContain('padding-bottom: 0;');
  expect(css).not.toContain('.entryReview .categoryReview');
  expect(categoryCss.match(/(?:^|\n)\.category \{([^}]+)\}/)?.[1]).toContain('overflow: auto;');
  expect(categoryCss.match(/(?:^|\n)\.sample \{([^}]+)\}/)?.[1]).toContain('overflow: auto;');
  expect(categoryCss.match(/(?:^|\n)\.comparison section \{([^}]+)\}/)?.[1]).toContain(
    'overflow: auto;',
  );
  expect(categoryCss.match(/(?:^|\n)\.categoryButtons \{([^}]+)\}/)?.[1]).toContain(
    'grid-auto-rows: max-content;',
  );
  expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.categoryReview \{[^}]*height: auto;/);
  expect(categoryCss).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.category \{[^}]*overflow: visible;/,
  );
});
