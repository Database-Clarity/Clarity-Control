/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary, statusBarClip } from './known-defects.mjs';

// Overhaul P2 step 7 in the real shell on synthetic data: the suggestion menu (opened by < and by
// Ctrl+Space), its category list, rendered detail pane and the phone bottom sheet. Both themes at
// 390 / 768 / 1280: zero horizontal overflow, nothing clipped, no wrapping inside option rows, the
// menu never over the caret line (desktop) and the text never moving while browsing.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s7-shots');
await mkdir(shots, { recursive: true });
const port = 5297;
const url = `http://127.0.0.1:${port}/test/shell.html`;

// A production build of the test pages by default (harness-server.mjs).
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const metrics = (page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    return {
      // The first line's position in page coordinates: scrolling the page is not the text moving.
      line: Math.round(
        document.querySelector('.cm-line').getBoundingClientRect().top +
          window.scrollY +
          scroller.scrollTop,
      ),
      editorHeight: Math.round(document.querySelector('.cm-editor').getBoundingClientRect().height),
    };
  });
const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
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
    });
    const name = (el) => `${el.tagName}.${String(el.className).slice(0, 40)}`;
    const inBar = (el) => el.parentElement?.closest('[data-editor-status]');
    // The known defect is a phone-width one: anywhere wider, a cut bar item fails outright.
    const phoneWidth = window.innerWidth <= 400;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      wide: wide
        .filter((el) => !phoneWidth || !inBar(el))
        .slice(0, 5)
        .map(name),
      bar: wide
        .filter((el) => phoneWidth && inBar(el))
        .slice(0, 5)
        .map((el) => `${name(el)} "${el.textContent}"`),
    };
  });
  if (overflow.page > 0 || overflow.wide.length || overflow.bar.length)
    await page.screenshot({ path: `${shots}/FAIL-${label.replaceAll(' ', '-')}.png` });
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
  statusBarClip(label, overflow.bar);
};
/** The menu fits the window, rows are one line, and (desktop) it stays off the caret line. */
const menuProblems = (page, phone) =>
  page.evaluate((onPhone) => {
    const menu = document.querySelector('[data-suggest-menu]');
    if (!menu) return ['no menu'];
    const problems = [];
    const r = menu.getBoundingClientRect();
    if (r.left < -1 || r.right > window.innerWidth + 1)
      problems.push('menu leaves the window sideways');
    if (r.top < -1 || r.bottom > window.innerHeight + 1)
      problems.push(`menu leaves the window ${JSON.stringify(r)}`);
    for (const el of menu.querySelectorAll('[role=option], [role=presentation]')) {
      const box = el.getBoundingClientRect();
      if (!box.width) continue;
      const range = document.createRange();
      range.selectNodeContents(el.querySelector('span') ?? el);
      const tops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
      if (tops.length && Math.max(...tops) - Math.min(...tops) > 6)
        problems.push(`${el.textContent} wraps inside its row`);
    }
    const cursor = document.querySelector('.cm-cursor')?.getBoundingClientRect();
    if (cursor && !onPhone && r.top < cursor.bottom - 1 && r.bottom > cursor.top + 1)
      problems.push('menu covers the caret line');
    if (cursor && onPhone && r.top < cursor.bottom && r.bottom > cursor.top)
      problems.push('sheet covers the caret line');
    return problems;
  }, phone);

/** The symbol view hides tag markup and tints what it encloses: read the tints as "tag:text". */
const tintedText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-tint')].map(
      (el) => `${el.className.split(' ').pop()}:${el.textContent}`,
    ),
  );

async function open(theme, viewport, phone) {
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

try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      const label = `${theme} ${width}`;
      const { context, page, errors } = await open(theme, { width, height }, phone);
      const text = page.locator('.cm-content');
      await text.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n\nGains 6.5 [5] reload speed ');
      const settled = await metrics(page);

      // A typed "<" opens the menu; browsing it moves nothing and changes nothing.
      await page.keyboard.type('<pv');
      const menu = page.locator('[data-suggest-menu]');
      await menu.waitFor();
      const typed = await page.evaluate(() => document.querySelector('.cm-content').textContent);
      assert.ok(typed.endsWith('<pv'), `${label}: typed text is in the document`);
      const options = page.locator('[role=option]');
      assert.ok((await options.count()) >= 3, `${label}: menu lists options`);
      const before = await metrics(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      assert.deepEqual(await metrics(page), before, `${label}: browsing moved the text`);
      assert.equal(
        await page.evaluate(() => document.querySelector('.cm-content').textContent),
        typed,
        `${label}: browsing changed the document`,
      );
      assert.deepEqual(await menuProblems(page, phone), [], `${label}: menu problems`);
      await noOverflow(page, `${label} menu open`);
      const detail = menu.locator('[data-suggest-detail]');
      assert.ok(
        (await detail.locator('pre').innerText()).includes('<pv'),
        `${label}: markup shown`,
      );
      assert.ok(await detail.locator('[aria-label=Preview]').count(), `${label}: rendered preview`);
      assert.match(await detail.locator('[data-suggest-usage]').innerText(), /^(Used in|Not used)/);
      await page.screenshot({ path: `${shots}/${theme}-${width}-menu.png` });

      // Esc closes without inserting; the text is exactly what was typed.
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(), 0, `${label}: Esc closes the menu`);
      assert.equal(
        await page.evaluate(() => document.querySelector('.cm-content').textContent),
        typed,
        `${label}: Esc changed the document`,
      );

      // Enter inserts the highlighted option and selects its first stop.
      for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('<pve');
      await menu.waitFor();
      await page.keyboard.press('Enter');
      assert.equal(await menu.count(), 0, `${label}: Enter closes the menu`);
      // The symbol view hides tag markup and tints what it encloses: the inserted
      // `<pve value />` reads as a tinted "value" after "speed ".
      const inserted = await page.evaluate(() => document.querySelector('.cm-content').textContent);
      assert.ok(
        inserted.endsWith('speed value'),
        `${label}: Enter inserted the tag (${JSON.stringify(inserted.slice(-40))})`,
      );
      assert.ok(
        (await tintedText(page)).at(-1) === 'cm-tint-pve:value',
        `${label}: Enter inserted a pve tag (${await tintedText(page)})`,
      );
      assert.ok(await page.locator('.cm-selectionBackground, .cm-suggestStop').count());
      assert.equal(
        (await metrics(page)).line,
        settled.line,
        `${label}: insert moved the first line`,
      );
      await page.screenshot({ path: `${shots}/${theme}-${width}-inserted.png` });

      // Ctrl+Space on a selection: Transforms first, with the converted line in the detail pane.
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n6.5 [5]');
      for (let i = 0; i < '6.5 [5]'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Control+Space');
      await menu.waitFor();
      const first = await menu.locator('[role=presentation]').first().innerText();
      assert.equal(first.trim().toLowerCase(), 'transforms', `${label}: Transforms lead`);
      assert.match(await menu.locator('[role=option]').first().innerText(), /PvE and PvP/);
      assert.deepEqual(await menuProblems(page, phone), [], `${label}: transform menu problems`);
      await noOverflow(page, `${label} transform menu`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-transform.png` });
      await page.keyboard.press('Enter');
      const pair = await tintedText(page);
      assert.ok(
        (await page.evaluate(() => document.querySelector('.cm-content').textContent)).endsWith(
          '6.5 [5]',
        ) &&
          pair.at(-2) === 'cm-tint-pve:6.5' &&
          pair.at(-1) === 'cm-tint-pvp:[5]',
        `${label}: the selection became the pair (${pair})`,
      );
      // The caret line scrolling out of the editor takes the menu with it (never floats over the bar).
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n');
      await page.keyboard.type('<pv');
      await menu.waitFor();
      await page.evaluate(() => {
        document.querySelector('.cm-scroller').scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(100);
      const stray = await page.evaluate(() => {
        const m = document.querySelector('[data-suggest-menu]')?.getBoundingClientRect();
        const scroller = document.querySelector('.cm-scroller').getBoundingClientRect();
        const cursor = document.querySelector('.cm-cursor')?.getBoundingClientRect();
        return !m || !cursor
          ? null
          : { m, scroller, cursor, outside: m.bottom > window.innerHeight + 1 || m.top < -1 };
      });
      assert.ok(
        !stray || !stray.outside,
        `${label}: menu left the window ${JSON.stringify(stray)}`,
      );
      await page.keyboard.press('Escape');

      // Touch: no Ctrl+Space, so Suggest is a real touch-size button (36px compact at 100%, the
      // default since f126ec68), and an opened menu has a Close. On a phone it sits in the markup
      // bar docked on the keyboard, beside All (092cdeaa); never in the status bar.
      const suggest = page.locator('[data-markup-row] button', { hasText: 'Suggest' });
      assert.equal(
        await page
          .locator('[data-editor-status] button', { hasText: 'Suggest' })
          .filter({ visible: true })
          .count(),
        0,
        `${label}: no Suggest shown in the status bar`,
      );
      if (phone) {
        const box = await suggest.boundingBox();
        assert.ok(box && box.height >= 35, `${label}: Suggest is a 36px button (${box?.height})`);
        await page.keyboard.press('Control+End');
        await page.keyboard.insertText('\n2 [3]');
        for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
        await suggest.click();
        await menu.waitFor();
        assert.match(await menu.locator('[role=option]').first().innerText(), /PvE and PvP/);
        assert.deepEqual(await menuProblems(page, phone), [], `${label}: phone menu problems`);
        await page.screenshot({ path: `${shots}/${theme}-${width}-suggest-button.png` });
        await menu.getByRole('button', { name: 'Close' }).click();
        assert.equal(await menu.count(), 0, `${label}: Close closes the menu`);
      } else {
        assert.equal(
          await suggest.isVisible(),
          false,
          `${label}: no Suggest button with a keyboard`,
        );
      }
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }
  knownDefectSummary();
  console.log('suggest menu browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
