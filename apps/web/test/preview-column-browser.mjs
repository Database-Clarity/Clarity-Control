/* global document, window, getComputedStyle, Node, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary } from './known-defects.mjs';

// The preview column (overhaul P2 step 3) in the real shell on synthetic data, both themes, at 390 /
// 768 / 1280: ONE perk header above Base | Enhanced | Compare, Compare by default on a desktop and
// Enhanced on a phone, a thin pale-gold arrow, a light surface in the light theme, no horizontal
// overflow, no clipped or wrapping controls, and editor text that never moves when the view changes.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s3-shots');
await mkdir(shots, { recursive: true });
const port = 5293;
const url = `http://127.0.0.1:${port}/test/shell.html`;

// A production build of the test pages by default (harness-server.mjs).
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const firstLine = (page) =>
  page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((el) => el.offsetParent);
    const rect = line?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), left: Math.round(rect.left) } : null;
  });
const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.right > window.innerWidth + 1 &&
          !el.closest('[hidden]') &&
          !el.closest('.cm-scroller') &&
          // The markup row scrolls its buttons sideways inside its own box (the box itself must
          // still fit the window).
          !el.parentElement?.closest('[data-markup-row] [role=toolbar]') &&
          // Never-seen measuring copies (e.g. the phone tools' fit clip) are not on screen.
          window.getComputedStyle(el).visibility !== 'hidden'
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};
/** Everything in the preview column's bar fits on one line and nothing is cut off. */
const barProblems = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[aria-label="Preview version"]')?.parentElement;
    if (!bar) return ['no bar'];
    const problems = [];
    const barRect = bar.getBoundingClientRect();
    for (const el of bar.querySelectorAll('button, select, span')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > barRect.right + 1) problems.push(`${el.textContent} past the bar`);
      const style = getComputedStyle(el);
      const line = parseFloat(style.lineHeight) || 14;
      if (el.tagName === 'BUTTON' && r.height > 2 * line + 12)
        problems.push(`${el.textContent} wraps`);
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`${el.textContent} clipped`);
    }
    return problems;
  });
const pressed = (page) =>
  page.locator('[aria-label="Preview version"] button[aria-pressed="true"]').allTextContents();

async function open(theme, viewport, { phone = false } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', collectPageErrors(errors));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate(() => {
    window.shellFixture.role('maintainer');
    window.shellFixture.variants();
    window.shellFixture.kinetic();
  });
  await page.evaluate(() => {
    window.location.hash = '#/t/1000?lang=en';
  });
  await page.locator('.cm-content').first().waitFor();
  return { context, page, errors };
}

/** The column is collapsed by default in compact windows; open it like the user would. */
async function showColumn(page) {
  const show = page.getByRole('button', { name: /Show preview column/ });
  if (await show.count()) await show.first().click();
  await page.locator('[aria-label="Preview version"]').first().waitFor();
}

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      const label = `${theme} ${width}`;
      const { context, page, errors } = await open(theme, { width, height }, { phone });
      if (phone) await page.getByRole('tab', { name: 'Preview' }).click();
      else await showColumn(page);

      // ONE perk header (name once) above the switch; the default view depends on the device.
      const preview = page.getByRole('region', { name: 'Hammerhead preview' }).first();
      assert.equal(await preview.locator('header').count(), 1, `${label}: one perk header`);
      assert.equal(await page.locator('[aria-label="Preview version"]').count(), 1);
      const order = await preview.evaluate((el) => {
        const header = el.querySelector('header');
        const bar = el.querySelector('[aria-label="Preview version"]');
        return Boolean(
          header && bar && header.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      });
      assert.ok(order, `${label}: header comes before the switch`);
      // The default view settles once the item's enhanced version is known (Base until then).
      const want = phone ? 'Enhanced' : 'Compare';
      await page
        .waitForFunction(
          (mode) =>
            [
              ...document.querySelectorAll(
                '[aria-label="Preview version"] button[aria-pressed="true"]',
              ),
            ]
              .map((b) => b.textContent)
              .join() === mode,
          want,
          { timeout: 3000 },
        )
        .catch(() => {});
      assert.deepEqual(await pressed(page), [want], `${label}: default`);

      const topBefore = phone ? null : await firstLine(page);
      for (const mode of ['Base', 'Enhanced', 'Compare']) {
        await page
          .locator('[aria-label="Preview version"]')
          .getByRole('button', { name: mode, exact: true })
          .click();
        assert.deepEqual(await pressed(page), [mode], `${label}: ${mode} pressed`);
        assert.deepEqual(await barProblems(page), [], `${label} ${mode}: bar clips or wraps`);
        await noOverflow(page, `${label} ${mode}`);
        // The version strip is 28px (on a phone: --tap-sm, 28px at 100%, f126ec68). A phone's
        // Compare count takes its own line under the strip, the bar's only second line.
        const bar = await page.locator('[aria-label="Preview version"]').evaluate((el) => {
          const strip = el.parentElement.getBoundingClientRect();
          const count = el.parentElement.querySelector('[aria-live="polite"]');
          const line = count?.getBoundingClientRect();
          return {
            height: Math.round(strip.height),
            countLine: line && line.height ? Math.round(line.height) : 0,
            countBelow: Boolean(line && line.top >= el.getBoundingClientRect().bottom - 1),
          };
        });
        const ownLine = phone && mode === 'Compare';
        if (ownLine)
          assert.ok(
            bar.countBelow && bar.height <= 28 + bar.countLine + 8,
            `${label} ${mode}: count line under the strip ${JSON.stringify(bar)}`,
          );
        else assert.equal(bar.height, 28, `${label} ${mode}: bar height ${JSON.stringify(bar)}`);
        if (mode === 'Compare') {
          assert.equal(
            (await preview.locator('[aria-live="polite"]').textContent()).trim(),
            '9 changes vs Base',
          );
          assert.equal(await page.locator('[data-kind="changed"]').count(), 8);
          assert.equal(await page.locator('[data-kind="added"]').count(), 1);
          assert.ok(await page.locator('[data-kind="changed"] [role="img"]').count());
          // The thin arrow is pale gold in dark, deep gold in light.
          const arrow = await page
            .locator('[data-kind="changed"] [role="img"]')
            .first()
            .evaluate((el) => getComputedStyle(el).backgroundColor);
          assert.equal(arrow, theme === 'dark' ? 'rgb(234, 222, 139)' : 'rgb(122, 100, 0)');
          const edge = await page
            .locator('[data-kind="added"]')
            .evaluate((el) => getComputedStyle(el).boxShadow);
          assert.ok(edge.includes('2px'), `${label}: gold edge on the enhanced-only line`);
        } else {
          assert.equal(await page.locator('[data-compare]').count(), 0);
          assert.equal(
            await page
              .locator('[aria-label="Preview version"]')
              .locator('xpath=..//span')
              .last()
              .textContent(),
            '',
          );
        }
        if (mode === 'Enhanced') {
          assert.ok(
            (await preview.innerText()).includes('Hit Requirements are decreased by 1.'),
            `${label}: Enhanced shows the enhanced line`,
          );
        } else if (mode === 'Base') {
          assert.ok(!(await preview.innerText()).includes('Hit Requirements are decreased'));
        }
        // The light theme previews on a light surface.
        const surface = await preview
          .locator('xpath=.//div[contains(@class,"description")]')
          .first()
          .evaluate((el) => getComputedStyle(el.parentElement).backgroundColor);
        const [r, g, b] = surface.match(/\d+/g).map(Number);
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        assert.ok(
          theme === 'light' ? luminance > 0.9 : luminance < 0.1,
          `${label}: preview surface ${surface}`,
        );
        await page.screenshot({ path: out(`${mode.toLowerCase()}-${width}`) });
      }
      if (!phone)
        assert.deepEqual(await firstLine(page), topBefore, `${label}: editor text did not move`);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }
  // A long text scrolls under the pinned header and strip; the strip spans the column.
  for (const theme of ['dark', 'light']) {
    const { context, page } = await open(theme, { width: 1280, height: 420 });
    await showColumn(page);
    // The preview takes the kinetic fixture's text (long enough to scroll) once it renders it.
    const waited = Date.now();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Hammerhead preview"]')
          ?.textContent.includes('Scoring multiple'),
      undefined,
      { timeout: 10000 },
    );
    console.log(
      `${theme} 1280x420: preview showed the fixture text after ${Date.now() - waited} ms`,
    );
    const result = await page.evaluate(async () => {
      const header = document.querySelector('[aria-label="Hammerhead preview"] header');
      let scroller = header.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1)
        scroller = scroller.parentElement;
      if (!scroller) return { scrolled: false };
      scroller.scrollTop = 120;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const bar = document.querySelector('[aria-label="Preview version"]').parentElement;
      const column = header.closest('section').getBoundingClientRect();
      return {
        scrolled: scroller.scrollTop > 0,
        headerTop: Math.round(
          header.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        ),
        barTop: Math.round(bar.getBoundingClientRect().top - header.getBoundingClientRect().bottom),
        barWidth: Math.round(bar.getBoundingClientRect().width),
        columnWidth: Math.round(column.width),
      };
    });
    if (!result.scrolled) await page.screenshot({ path: `${shots}/FAIL-${theme}-1280x420.png` });
    assert.ok(result.scrolled, `${theme}: the column scrolls at 420px`);
    assert.ok(Math.abs(result.headerTop) <= 1, `${theme}: header pinned (${result.headerTop})`);
    assert.ok(Math.abs(result.barTop) <= 1, `${theme}: strip pinned under it (${result.barTop})`);
    assert.equal(result.barWidth, result.columnWidth, `${theme}: strip spans the column`);
    await page.screenshot({ path: `${shots}/${theme}-pinned-1280x420.png` });
    await context.close();
  }
  knownDefectSummary();
  console.log('Preview column browser checks passed.');
} finally {
  await browser.close();
  await server.close();
}
