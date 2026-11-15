/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary } from './known-defects.mjs';

// Overhaul P2 step 4 in the real shell on synthetic data: the editor status bar (24px, 52px on a
// phone), the character-warning and markup-help panels that open UPWARD over the text without
// moving it, the light editor, the not-previewed notice with Show preview, and the interface scale
// (85 / 100 / 150 %). Both themes at 390 / 768 / 1280: zero horizontal overflow, nothing clipped,
// no wrapping inside controls.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s4-shots');
await mkdir(shots, { recursive: true });
const port = 5294;
const url = `http://127.0.0.1:${port}/test/shell.html`;

// A production build of the test pages by default (harness-server.mjs).
const server = await startHarnessServer(web, port);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const metrics = (page) =>
  page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((el) => el.offsetParent);
    const scroller = document.querySelector('.cm-scroller');
    const editor = document.querySelector('.cm-editor');
    return {
      // Page coordinates: scrolling the page to reach a button is not the text moving.
      line: Math.round(
        document.querySelector('.cm-content').getBoundingClientRect().top +
          window.scrollY +
          scroller.scrollTop,
      ),
      lineLeft: line ? Math.round(line.getBoundingClientRect().left) : null,
      editorHeight: Math.round(editor.getBoundingClientRect().height),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
  });
/**
 * An open panel draws over the text and moves nothing; it only gives the text room below its last
 * line equal to the panel's height (--overlay-room, d4b44c24), so the end can scroll clear of it.
 */
const panelKeepsText = async (page, before, label) => {
  const { scrollHeight, ...open } = await metrics(page);
  const { scrollHeight: closedHeight, ...closed } = before;
  assert.deepEqual(open, closed, `${label}: moved the text`);
  const room = await page.evaluate(() =>
    Math.round(document.querySelector('[data-editor-overlay]').getBoundingClientRect().height),
  );
  assert.ok(
    scrollHeight >= closedHeight && scrollHeight <= closedHeight + room + 1,
    `${label}: room below the text ${scrollHeight - closedHeight}px for a ${room}px panel`,
  );
};
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
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
  assert.deepEqual(overflow.bar, [], `${label}: status bar items run past the window`);
};
/** Everything in the status bar fits on one line and nothing but the flexible texts is cut. */
const barProblems = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-editor-status]');
    if (!bar) return ['no status bar'];
    const problems = [];
    const barRect = bar.getBoundingClientRect();
    if (bar.scrollWidth > bar.clientWidth + 1) problems.push('bar scrolls');
    for (const el of bar.querySelectorAll('button, span')) {
      // Hints that do not fit wrap out of their one-line box on purpose.
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > barRect.right + 1 || r.bottom > barRect.bottom + 1 || r.top < barRect.top - 1)
        problems.push(`${el.textContent} outside the bar`);
      const style = getComputedStyle(el);
      // A button is one line: it cannot wrap (nowrap) and its text is a single line box.
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = [...range.getClientRects()].map((rect) => rect.top);
      const lines = tops.length && Math.max(...tops) - Math.min(...tops) > 6 ? 2 : 1;
      if (el.tagName === 'BUTTON' && (style.whiteSpace !== 'nowrap' || lines > 1))
        problems.push(`${el.textContent} wraps`);
      const flexible = el.matches('[data-status-reason]') || style.textOverflow === 'ellipsis';
      if (!flexible && el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1)
        problems.push(`${el.textContent} clipped`);
    }
    return problems;
  });

async function open(theme, viewport, { phone = false, scale } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (scale) {
    await context.addInitScript((value) => {
      try {
        localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
      } catch {
        /* none */
      }
    }, scale);
  }
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

const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const panelButton = (page, name) =>
  page.locator(`[data-editor-status] button[aria-controls="${name}"]`);

try {
  for (const theme of ['dark', 'light']) {
    for (const scale of [undefined, 85, 150]) {
      for (const [width, height, phone] of [
        [1280, 800, false],
        [768, 900, false],
        [390, 844, true],
      ]) {
        const label = `${theme} ${width} scale ${scale ?? 100}`;
        const name = `${theme}-${width}${scale ? `-s${scale}` : ''}`;
        const { context, page, errors } = await open(theme, { width, height }, { phone, scale });
        // A wide scale is limited where it would squeeze a tablet-width window below 701px.
        const applied =
          scale > 100 && width > 700
            ? Math.min(scale, Math.floor((width / 710) * 100))
            : (scale ?? 100);
        const factor = applied / 100;
        if (scale) {
          const root = await page.evaluate(
            () => getComputedStyle(document.documentElement).fontSize,
          );
          assert.equal(root, `${16 * factor}px`, `${label}: root font size`);
        }

        // The bar: 24px (on a phone the compact touch row, --tap-sm + 0.25rem = 32px at 100%,
        // following the interface scale since f126ec68), under the text, one line, nothing cut.
        const bar = page.locator('[data-editor-status]').first();
        await bar.waitFor();
        const barHeight = Math.round((await bar.boundingBox()).height);
        const want = Math.round((phone ? 32 : 24) * factor);
        assert.ok(
          Math.abs(barHeight - want) <= 1,
          `${label}: bar height ${barHeight}, want ${want}`,
        );
        const problems = await barProblems(page);
        assert.deepEqual(problems, [], `${label}: bar problems`);
        await noOverflow(page, label);

        // The editor is a light object in the light theme and dark in the dark one.
        const editorBg = await page.evaluate(
          () => getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
        );
        assert.ok(
          theme === 'light' ? luminance(editorBg) > 0.9 : luminance(editorBg) < 0.2,
          `${label}: editor surface ${editorBg}`,
        );

        // Opening the panels draws over the text: the text, its height and scroll never change.
        const before = await metrics(page);
        await panelButton(page, 'editor-panel-help').click();
        const overlay = page.locator('[data-editor-overlay]');
        await overlay.waitFor();
        const geometry = await page.evaluate(() => {
          const o = document.querySelector('[data-editor-overlay]').getBoundingClientRect();
          const b = document.querySelector('[data-editor-status]').getBoundingClientRect();
          const e = document.querySelector('.cm-editor').getBoundingClientRect();
          const tops = ['header', '[aria-label="Tooltip panels"]'].map(
            (selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0,
          );
          return {
            overlayTop: Math.round(o.top),
            overlayBottom: Math.round(o.bottom),
            barTop: Math.round(b.top),
            chromeBottom: Math.round(Math.max(0, ...tops)),
            windowBottom: window.innerHeight,
            over: o.top < e.bottom,
          };
        });
        if (phone) {
          // A phone's help is a bottom sheet over the page (36596aa5, c5566efd): on the window's
          // bottom edge (no keyboard here), never over the header or the panel tabs.
          assert.ok(
            Math.abs(geometry.overlayBottom - geometry.windowBottom) <= 1 &&
              geometry.overlayTop >= geometry.chromeBottom - 1,
            `${label}: help sheet between the panel tabs and the window bottom ${JSON.stringify(geometry)}`,
          );
        } else {
          assert.ok(
            Math.abs(geometry.overlayBottom - geometry.barTop) <= 1,
            `${label}: panel sits directly above the bar`,
          );
        }
        assert.ok(geometry.over, `${label}: panel is over the text`);
        await panelKeepsText(page, before, `${label}: help panel`);
        await noOverflow(page, `${label} help open`);
        await page.screenshot({ path: `${shots}/${name}-help.png` });

        // A glyph warning: type an unvetted arrow; the count appears without moving the text.
        // The panel covers part of the text, so focus the text instead of clicking through it.
        await page.locator('.cm-content').focus();
        await page.keyboard.press('Escape');
        assert.equal(await overlay.count(), 0, `${label}: Esc closes the panel`);
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+End');
        const beforeType = await metrics(page);
        await page.keyboard.insertText(' \u{1F81A}');
        const glyph = panelButton(page, 'editor-panel-glyphs');
        await glyph.waitFor();
        const afterType = await metrics(page);
        assert.equal(
          afterType.line,
          beforeType.line,
          `${label}: typing moved the first line ${JSON.stringify([beforeType, afterType])}`,
        );
        const warned = await barProblems(page);
        assert.deepEqual(warned, [], `${label}: bar problems with warnings`);
        const typed = await metrics(page);
        await glyph.click();
        await overlay.waitFor();
        await panelKeepsText(page, typed, `${label}: glyph panel`);
        const replace = overlay.getByRole('button', { name: /Replace first/ });
        // The offer renders with the panel's content, after it opens: wait for it.
        await replace
          .first()
          .waitFor({ timeout: 5000 })
          .catch(() => {});
        assert.ok(await replace.count(), `${label}: glyph panel offers the replacement`);
        await noOverflow(page, `${label} glyphs open`);
        const wrapped = await replace.evaluate(
          (el) => el.getBoundingClientRect().right <= window.innerWidth,
        );
        assert.ok(wrapped, `${label}: replace button inside the window`);
        await page.screenshot({ path: `${shots}/${name}-glyphs.png` });
        await overlay.getByRole('button', { name: /^Close/ }).click();
        assert.equal(await overlay.count(), 0);
        assert.deepEqual(errors, [], `${label}: no page errors`);
        await context.close();
      }
    }
  }

  // At 150 % a one-row header would crush the finder: the compact layout follows the scale.
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 1440]) {
      const { context, page, errors } = await open(theme, { width, height: 800 }, { scale: 150 });
      const finder = await page.getByRole('combobox', { name: 'Tooltip' }).boundingBox();
      assert.ok(finder.width >= 200, `${theme} ${width} s150: finder is ${finder.width}px wide`);
      // The category select became a custom list (cb93a2d8): a "Category" combobox.
      const select = await page
        .locator('header')
        .getByRole('combobox', { name: 'Category' })
        .first()
        .boundingBox();
      assert.ok(select.width >= 120, `${theme} ${width} s150: category select ${select.width}px`);
      await noOverflow(page, `${theme} ${width} s150 header`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-s150-header.png` });
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  // The phone's view tabs never break a word at 150 %.
  {
    const { context, page } = await open(
      'light',
      { width: 390, height: 844 },
      { phone: true, scale: 150 },
    );
    const broken = await page.evaluate(
      () =>
        [...document.querySelectorAll('[role="tab"]')].filter(
          (tab) =>
            getComputedStyle(tab).whiteSpace !== 'nowrap' ||
            tab.getBoundingClientRect().height > 80,
        ).length,
    );
    assert.equal(broken, 0, 'phone view tabs stay on one line');
    await context.close();
  }

  // Unpreviewed edits (desktop): hide the preview, edit, and the bar says so and offers it.
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme, { width: 1280, height: 800 });
    const hide = page.getByRole('button', { name: /Collapse preview|Hide preview/ }).first();
    if (await hide.count()) await hide.click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(' changed');
    const status = page.locator('[data-editor-status]');
    await page.waitForFunction(() =>
      document.querySelector('[data-editor-status]')?.textContent.includes('not previewed'),
    );
    const before = await metrics(page);
    assert.match(await status.innerText(), /1 not previewed/);
    await page.screenshot({ path: `${shots}/${theme}-not-previewed-1280.png` });
    await status.getByRole('button', { name: /Show preview/ }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-editor-status]')?.textContent.includes('not previewed'),
    );
    assert.equal(
      (await metrics(page)).line,
      before.line,
      `${theme}: showing the preview moved the text`,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Interface scale in Settings: the range input applies at once and 100% resets it.
  {
    const { context, page } = await open('dark', { width: 1280, height: 800 });
    await page.locator('[data-settings-button]').click();
    const range = page.getByLabel('Interface scale');
    await range.waitFor();
    await range.fill('150');
    assert.equal(await page.evaluate(() => document.documentElement.style.fontSize), '150%');
    await page.screenshot({ path: `${shots}/dark-settings-s150.png` });
    await page.getByRole('button', { name: '100%', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.style.fontSize), '');
    await context.close();
  }
  knownDefectSummary();
  console.log('Status bar browser checks passed.');
} finally {
  await browser.close();
  await server.close();
}
