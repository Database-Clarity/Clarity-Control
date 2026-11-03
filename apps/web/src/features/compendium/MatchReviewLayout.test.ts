import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { expect, it } from 'vitest';

const css = compile(fileURLToPath(new URL('./MatchReview.module.scss', import.meta.url))).css;
const layoutSource = readFileSync(
  fileURLToPath(new URL('../navigation/Layout.tsx', import.meta.url)),
  'utf8',
);
const layoutCss = compile(
  fileURLToPath(new URL('../navigation/Layout.module.scss', import.meta.url)),
).css;
const categoryCss = compile(
  fileURLToPath(new URL('./CategoryReview.module.scss', import.meta.url)),
).css;
const reviewCss = compile(
  fileURLToPath(new URL('../review/Review.module.scss', import.meta.url)),
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
it('keeps the phone review actions and overlay clear of the home indicator, with no dock to reserve', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 700px)'));
  expect(mobile).toMatch(/\.actionBar \{[^}]*bottom: env\(safe-area-inset-bottom, 0px\);/);
  expect(mobile).toMatch(/\.overlay \{[^}]*--review-action-bar-height/);
  expect(css).toContain('var(--review-action-bar-height, 0px)');
  expect(css).not.toContain('--save-dock-height');
  expect(layoutCss).not.toContain('--save-dock-height');
  expect(css).toMatch(/\.actionBar button \{\s*min-height: max\(44px, 2\.75rem\);\s*\}/);
  expect(css).toContain('.actionConsequence');
  const reviewMobile = reviewCss.slice(reviewCss.indexOf('@media (max-width: 700px)'));
  const emptyActionRule = reviewMobile.match(/([^{}]*\.empty button[^{}]*)\{([^{}]*)\}/);
  expect(emptyActionRule?.[2]).toContain('min-height: max(44px, 2.75rem);');
  expect(categoryCss).toMatch(/@media \(max-width: 700px\)[\s\S]*\.actions \{\s*position: fixed;/);
  expect(categoryCss).toContain('.actionEyebrow');
});
it('keeps the desktop list column bounded under the header (whatever its height) and gives phones none', () => {
  const list = layoutCss.match(/\.left\[data-list\] \{([^}]+)\}/)?.[1];
  expect(list).toContain('position: sticky;');
  expect(list).toContain('top: var(--header-h, 37px);');
  expect(list).toContain('height: calc(100dvh - var(--header-h, 37px));');
  expect(layoutCss).toMatch(/\n\.left \{[^}]*overflow: auto;/);
  // The column exists only where the Layout sets data-column; a phone never does.
  expect(layoutCss).toContain('.body[data-column]');
  expect(layoutSource).toMatch(/hasColumn = !phone &&/);
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
    expect(targets).toContain('min-height: max(44px, 2.75rem);');
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
  expect(categoryCss.match(/(?:^|\n)\.sample \{([^}]+)\}/)?.[1]).toContain('overflow: visible;');
  expect(categoryCss.match(/(?:^|\n)\.comparison section \{([^}]+)\}/)?.[1]).toContain(
    'overflow: visible;',
  );
  expect(categoryCss.match(/(?:^|\n)\.categoryButtons \{([^}]+)\}/)?.[1]).toContain(
    'grid-auto-rows: max-content;',
  );
  expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.categoryReview \{[^}]*height: auto;/);
  expect(categoryCss).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.category \{[^}]*overflow: visible;/,
  );
  expect(categoryCss).not.toContain('padding-bottom: 14rem;');
});
