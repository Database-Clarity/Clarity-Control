/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary } from './known-defects.mjs';

// Overhaul P2 step 6, inline git-style conflicts, in the real shell on synthetic data with a fake
// save server: edit, Review and save -> 409 -> marker blocks in the editor (mine green, theirs
// blue, actions at the end of the active block's first line), F8, Compare, resolving, saving
// again, and the "another tab changed your drafts" pause. Both themes at 1280 / 768 / 390: zero
// horizontal overflow, nothing clipped, no wrapping inside controls, and no line ever changes
// height or moves because of the widget.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s6-shots');
await mkdir(shots, { recursive: true });
const port = 5396;
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
      // Page coordinates of the first line: scrolling the page is not the text moving.
      first: Math.round(
        document.querySelector('.cm-content').getBoundingClientRect().top +
          window.scrollY +
          scroller.scrollTop,
      ),
      editorHeight: Math.round(document.querySelector('.cm-editor').getBoundingClientRect().height),
    };
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
/** Every line of the text keeps one line-height, widget or not (a wrapped long line is a multiple). */
const lineHeights = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')].map((line) => ({
      text: line.textContent.slice(0, 24),
      height: Math.round(line.getBoundingClientRect().height * 10) / 10,
      marker: line.classList.contains('cm-conflict-marker'),
      open: line.classList.contains('cm-conflict-open'),
    })),
  );
/** The actions sit inside their line, right of the marker text, inside the editor. */
const widgetProblems = (page) =>
  page.evaluate(() => {
    const problems = [];
    const editor = document.querySelector('.cm-scroller').getBoundingClientRect();
    for (const widget of document.querySelectorAll('.cm-conflict-actions')) {
      const line = widget.closest('.cm-line');
      const w = widget.getBoundingClientRect();
      const l = line.getBoundingClientRect();
      if (w.top < l.top - 1 || w.bottom > l.bottom + 1) problems.push('widget leaves its line');
      if (w.right > editor.right + 1 || w.left < editor.left - 1)
        problems.push('widget outside the editor');
      // The marker text must stay readable: nothing of it is under the widget.
      const range = document.createRange();
      const marker = [...line.childNodes].find((n) => n.nodeType === 3);
      if (marker) {
        range.selectNodeContents(marker);
        const t = range.getBoundingClientRect();
        if (t.width && t.right > w.left + 1) problems.push('widget covers the marker text');
      }
      for (const button of widget.querySelectorAll('button')) {
        const r = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (r.right > editor.right + 1) problems.push(`${button.textContent} outside`);
        // The label must sit inside the button's own box (its invisible touch area is not text).
        const label = document.createRange();
        label.selectNodeContents(button);
        const text = label.getBoundingClientRect();
        if (text.left < r.left - 1 || text.right > r.right + 1)
          problems.push(`${button.textContent} clipped`);
        if (style.whiteSpace !== 'nowrap' && r.height > 28)
          problems.push(`${button.textContent} wraps`);
      }
    }
    return problems;
  });

let lastPage;
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
  lastPage = page;
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate(() => {
    window.shellFixture.role('maintainer');
    window.shellFixture.conflictText();
    window.shellFixture.conflictServer(
      [
        'Intro line of the tooltip',
        'Their line two',
        'Shared line three',
        'Their line four',
        'Shared line five',
        'Their closing line',
      ].join('\n'),
    );
  });
  await page.evaluate(() => {
    window.location.hash = '#/t/1000?lang=en';
  });
  await page.locator('.cm-content').first().waitFor();
  return { context, page, errors };
}

/** Types over line 2 and line 4 of the text (the lines the fake server also changed). */
async function edit(page) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  for (const [downs, text] of [
    [1, 'My line two'],
    [2, 'My line four'],
  ]) {
    for (let i = 0; i < downs; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.insertText(text);
  }
}

async function save(page) {
  await page.locator('[data-drafts-button]').click();
  await page.getByRole('dialog', { name: 'Drafts' }).waitFor();
  await page.locator('[data-drafts-review]').click();
  await page.getByRole('button', { name: 'Save changes' }).click();
}

// The document text: the action widgets are not part of it.
const doc = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')]
      .map((line) => {
        const copy = line.cloneNode(true);
        for (const widget of copy.querySelectorAll('.cm-conflict-actions')) widget.remove();
        return copy.textContent;
      })
      .join('\n'),
  );

try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      const label = `${theme} ${width}`;
      const name = `${theme}-${width}`;
      const { context, page, errors } = await open(theme, { width, height }, phone);
      await edit(page);
      await save(page);

      // The review closed; the draft now carries two marker blocks.
      await page.locator('.cm-conflict-open').first().waitFor();
      assert.equal(await page.locator('.cm-conflict-open').count(), 2, `${label}: two blocks`);
      assert.equal(await page.getByRole('dialog', { name: 'Review save' }).count(), 0);
      const text = await doc(page);
      assert.match(
        text,
        /<<<<<<< mine\nMy line two\n=======\nTheir line two\n>>>>>>> theirs \(bob, /,
        label,
      );
      assert.match(text, /Their closing line/, `${label}: their clean change came along`);
      assert.match(text, /^Intro line/, label);

      // Colours: mine and theirs lines have different backgrounds, markers a third.
      const colours = await page.evaluate(() => {
        const bg = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
        return {
          mine: bg('.cm-conflict-mine'),
          theirs: bg('.cm-conflict-theirs'),
          marker: bg('.cm-conflict-marker'),
          editor: bg('.cm-editor'),
        };
      });
      assert.equal(
        new Set(Object.values(colours)).size,
        4,
        `${label}: distinct tints ${JSON.stringify(colours)}`,
      );

      // No line is taller than the plain lines because of the widget.
      const heights = await lineHeights(page);
      const plain = heights.find((line) => !line.marker && line.text.startsWith('Intro'));
      for (const line of heights.filter((entry) => entry.marker))
        assert.equal(line.height, plain.height, `${label}: marker line "${line.text}" height`);
      assert.deepEqual(await widgetProblems(page), [], `${label}: widget problems`);
      await noOverflow(page, label);

      // Actions: the full set on the active block (desktop), one chip on touch; Compare elsewhere.
      const first = page
        .locator('.cm-conflict-open')
        .first()
        .locator('.cm-conflict-actions button');
      const second = page
        .locator('.cm-conflict-open')
        .nth(1)
        .locator('.cm-conflict-actions button');
      if (phone) {
        assert.deepEqual(await first.allInnerTexts(), ['Resolve'], `${label}: touch chip`);
      } else {
        assert.deepEqual(
          await first.allInnerTexts(),
          ['Accept mine', 'Accept theirs', 'Accept both', 'Compare'],
          `${label}: active block actions`,
        );
        assert.deepEqual(await second.allInnerTexts(), ['Compare'], `${label}: other block`);
      }

      // The status bar counts them; the drafts popover says Resolve.
      const conflictButton = page.locator('[data-status-conflicts]');
      assert.equal((await conflictButton.innerText()).trim(), '2 conflicts', label);
      await page.screenshot({ path: `${shots}/${name}-blocks.png` });

      // F8 / Shift+F8 move between the blocks; the caret lands on the marker line.
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+Home');
      const beforeJump = await metrics(page);
      await page.keyboard.press('F8');
      const head = () =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return selection?.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? '';
        });
      assert.match(await head(), /^<<<<<<< mine/, `${label}: F8 lands on a marker line`);
      await page.keyboard.press('F8');
      await page.keyboard.press('Shift+F8');
      assert.deepEqual(
        (await metrics(page)).first,
        beforeJump.first,
        `${label}: F8 moved the text`,
      );

      // Compare covers the text without resizing it, and Esc comes back.
      const beforeCompare = await metrics(page);
      if (phone) {
        await first.first().click();
        await page.getByRole('button', { name: 'Compare', exact: true }).click();
      } else {
        await first.last().click();
      }
      const compare = page.locator('[data-conflict-compare]');
      await compare.waitFor();
      assert.deepEqual(await metrics(page), beforeCompare, `${label}: Compare moved the text`);
      const compareText = await compare.innerText();
      assert.match(compareText, /Mine/);
      assert.match(compareText, /Base/);
      assert.match(compareText, /Theirs/);
      assert.match(compareText, /bob/);
      await noOverflow(page, `${label} compare`);
      await page.screenshot({ path: `${shots}/${name}-compare.png` });
      await page.keyboard.press('Escape');
      assert.equal(await compare.count(), 0, `${label}: Esc closes Compare`);

      // Resolve the active block (the one holding the caret): theirs first, then both.
      const resolveFirst = async (choice) => {
        if (phone) {
          await page
            .locator('.cm-conflict-open')
            .first()
            .locator('.cm-conflict-actions button')
            .click();
          await page.getByRole('button', { name: `Accept ${choice}` }).click();
        } else {
          await page
            .locator('.cm-conflict-current .cm-conflict-actions')
            .getByRole('button', { name: `Accept ${choice}` })
            .click();
        }
      };
      const beforeResolve = await metrics(page);
      await resolveFirst('theirs');
      assert.equal(await page.locator('.cm-conflict-open').count(), 1, `${label}: one block left`);
      assert.deepEqual(
        (await metrics(page)).first,
        beforeResolve.first,
        `${label}: resolving moved the first line`,
      );
      assert.equal((await conflictButton.innerText()).trim(), '1 conflict', label);
      await page.screenshot({ path: `${shots}/${name}-one-left.png` });
      await resolveFirst('both');
      assert.equal(await page.locator('.cm-conflict-open').count(), 0, `${label}: all resolved`);
      assert.equal(await conflictButton.count(), 0, `${label}: bar count gone`);
      const resolved = await doc(page);
      assert.match(resolved, /Their line two/, label);
      assert.match(resolved, /My line four\nTheir line four/, label);
      assert.doesNotMatch(resolved, /<<<<<<<|>>>>>>>/, label);
      await noOverflow(page, `${label} resolved`);

      // Save again: the fake server accepts it.
      await save(page);
      await page
        .getByText(/Saved 1 tooltip/)
        .first()
        .waitFor();
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }

  // A tooltip someone else deleted: a row under the preview asks Mine / Theirs; the drafts popover
  // says "Resolve 1 conflict" and offers no review until it is answered.
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
    ]) {
      const label = `${theme} ${width} deleted`;
      const { context, page, errors } = await open(theme, { width, height }, phone);
      await page.evaluate(() => window.shellFixture.conflictServer('', false, true));
      await edit(page);
      await save(page);
      const notice = page.getByText(/1 conflict needs your choice before saving/);
      await notice.waitFor();
      assert.equal(await page.locator('.cm-conflict-open').count(), 0, `${label}: no text block`);
      await page.locator('[data-drafts-button]').click();
      const popover = page.getByRole('dialog', { name: 'Drafts' });
      await popover.waitFor();
      assert.equal(
        await popover.getByRole('button', { name: 'Resolve 1 conflict' }).count(),
        1,
        label,
      );
      assert.equal(
        await popover.getByRole('button', { name: /Review and save/ }).count(),
        0,
        label,
      );
      assert.match(await popover.innerText(), /1 conflict/, label);
      await noOverflow(page, `${label} drafts`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-deleted-drafts.png` });
      await page.keyboard.press('Escape');
      if (width >= 1100) {
        const rows = page.locator('[data-conflict-rows]');
        await rows.waitFor();
        assert.match(await rows.innerText(), /Deleted on the server/, label);
        assert.deepEqual(
          await rows.getByRole('button').allInnerTexts(),
          ['Mine', 'Theirs'],
          `${label}: row buttons`,
        );
        const fits = await rows.evaluate((el) =>
          [...el.querySelectorAll('button')].every(
            (b) => b.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1,
          ),
        );
        assert.ok(fits, `${label}: row buttons inside the row`);
        await noOverflow(page, `${label} row`);
        await page.screenshot({ path: `${shots}/${theme}-${width}-deleted-row.png` });
        await rows.getByRole('button', { name: /Keep my value|Keep mine/ }).click();
        await rows.waitFor({ state: 'detached' });
        await notice.waitFor({ state: 'detached' });
        await save(page);
        await page
          .getByText(/Saved 1 tooltip/)
          .first()
          .waitFor();
      } else {
        await page.screenshot({ path: `${shots}/${theme}-${width}-deleted-notice.png` });
      }
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }

  // Another tab changes the drafts while conflicts are open: editing pauses and the notice asks.
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [390, 844, true],
    ]) {
      const label = `${theme} ${width} pause`;
      const { context, page, errors } = await open(theme, { width, height }, phone);
      await edit(page);
      await save(page);
      await page.locator('.cm-conflict-open').first().waitFor();
      const before = await metrics(page);
      const rowBefore = await page.locator('[data-markup-row]').count();
      await page.evaluate(() => window.shellFixture.otherTabWrote());
      const notice = page.getByRole('alert').filter({ hasText: 'changed in another tab' });
      await notice.waitFor();
      // The pause makes the text read-only; the markup row (open by default) stays, disabled,
      // so the text never moves.
      const paused = (await metrics(page)).first;
      const row = page.locator('[data-markup-row]');
      assert.equal(
        paused,
        before.first,
        `${label}: the pause moved the text ${before.first} -> ${paused} (markup row ${rowBefore} -> ${await row.count()})`,
      );
      assert.equal(await row.count(), rowBefore, `${label}: markup row kept`);
      if (rowBefore)
        assert.equal(await row.getAttribute('aria-disabled'), 'true', `${label}: row disabled`);
      assert.ok(await notice.getByRole('button', { name: 'Reload' }).count(), label);
      assert.ok(await notice.getByRole('button', { name: 'Keep mine' }).count(), label);
      assert.match(await page.locator('[data-editor-status]').innerText(), /Paused/, label);
      assert.equal(
        await page.locator('.cm-content').getAttribute('contenteditable'),
        'false',
        `${label}: editing is paused`,
      );
      await noOverflow(page, label);
      await page.screenshot({ path: `${shots}/${theme}-${width}-paused.png` });
      await notice.getByRole('button', { name: 'Keep mine' }).click();
      await notice.waitFor({ state: 'detached' });
      assert.equal(
        await page.locator('.cm-content').getAttribute('contenteditable'),
        'true',
        label,
      );
      assert.equal(await page.locator('.cm-conflict-open').count(), 2, `${label}: blocks kept`);
      assert.deepEqual(
        (await metrics(page)).first,
        before.first,
        `${label}: the answer moved the text`,
      );
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }
  knownDefectSummary();
  console.log('Conflicts browser checks passed.');
} catch (error) {
  if (lastPage) {
    await lastPage.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
    console.log(
      'Page text at failure:',
      (await lastPage.locator('body').innerText()).slice(0, 800),
    );
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
}
