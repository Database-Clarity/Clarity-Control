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
  expect(entry).toContain(
    'min-height: calc(100dvh - var(--header-h, 37px) - 2 * clamp(1rem, 3vw, 2rem));',
  );
  expect(entry).toContain('height: auto;');
  expect(entry).toContain('box-sizing: border-box;');
  const workspace = css.match(/\.workspace \{([^}]+)\}/)?.[1];
  expect(workspace).toContain('flex: 1 1 0;');
  expect(workspace).toContain('min-height: 0;');
  const card = css.match(/\.card \{([^}]+)\}/)?.[1];
  expect(card).toContain('overflow: auto;');
  expect(card).not.toMatch(/(?:^|\s)height:/);
  expect(css).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.entryReview \{\s*display: block;\s*height: auto;/,
  );
});
it('reserves approval rows in flow, without covering navigation or the phone home indicator', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 700px)'));
  const actions = css.match(/(?:^|\n)\.actionBar \{([^}]+)\}/)?.[1];
  expect(actions).toContain('position: static;');
  expect(actions).toContain('flex-shrink: 0;');
  expect(mobile).toMatch(/\.actionBar \{[^}]*padding:[^;]*safe-area-inset-bottom/);
  expect(mobile).toMatch(/\.overlay \{[^}]*safe-area-inset-bottom/);
  expect(css).not.toContain('--review-action-bar-height');
  expect(css).not.toContain('--save-dock-height');
  expect(layoutCss).not.toContain('--save-dock-height');
  expect(css).toMatch(/\.actionBar button \{\s*min-height: max\(44px, 2\.75rem\);\s*\}/);
  expect(css).toContain('.actionConsequence');
  const reviewMobile = reviewCss.slice(reviewCss.indexOf('@media (max-width: 700px)'));
  const emptyActionRule = reviewMobile.match(/([^{}]*\.empty button[^{}]*)\{([^{}]*)\}/);
  expect(emptyActionRule?.[2]).toContain('min-height: max(44px, 2.75rem);');
  expect(categoryCss.match(/\.sample > \.actions \{([^}]+)\}/)?.[1]).toContain('position: static;');
  expect(categoryCss).not.toMatch(/\.actions \{[^}]*position: (fixed|sticky);/);
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
it('budgets category space and lets an oversized workspace grow into document flow', () => {
  const category = css.match(/(?:^|\n)\.categoryReview \{([^}]+)\}/)?.[1];
  expect(category).toContain('display: flex;');
  expect(category).toContain(
    'min-height: calc(100dvh - var(--header-h, 37px) - 2 * clamp(1rem, 3vw, 2rem));',
  );
  expect(category).toContain('height: auto;');
  expect(category).toContain('padding-bottom: 0;');
  expect(categoryCss.match(/(?:^|\n)\.categories \{([^}]+)\}/)?.[1]).toContain('flex: 1 0 auto;');
  expect(css).not.toContain('.entryReview .categoryReview');
  expect(categoryCss.match(/(?:^|\n)\.category \{([^}]+)\}/)?.[1]).toContain('overflow: auto;');
  expect(categoryCss.match(/(?:^|\n)\.sample \{([^}]+)\}/)?.[1]).toContain('overflow: visible;');
  expect(categoryCss.match(/(?:^|\n)\.comparison section \{([^}]+)\}/)?.[1]).toContain(
    'overflow: visible;',
  );
  expect(categoryCss.match(/(?:^|\n)\.categoryButtons \{([^}]+)\}/)?.[1]).toContain(
    'flex-direction: column;',
  );
  expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.categoryReview \{[^}]*height: auto;/);
  expect(categoryCss).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.category \{[^}]*overflow: visible;/,
  );
  expect(categoryCss).not.toContain('padding-bottom: 14rem;');
});

it('contains the desktop category viewport while retaining a scroll range for scaled content', () => {
  const category = css.match(/\.categoryReview\[data-category-review\] \{([^}]+)\}/)?.[1];
  expect(category).toContain(
    'height: calc(100dvh - var(--header-h, 37px) - 2 * clamp(1rem, 3vw, 2rem));',
  );
  expect(category).toContain('min-height: 0;');
  expect(category).toContain('overflow: auto;');
  expect(category).toContain('contain: strict;');
});
