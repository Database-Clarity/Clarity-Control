/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary } from './known-defects.mjs';

// The editor page (overhaul P2 step 2) in the real shell on synthetic data, both themes, at 390 /
// 768 / 1280 (+1440, and 800 for the Compendium/English toggle): one editor, the 28px pane header,
// the left column's pinned rows, no horizontal overflow, no clipped or wrapping controls, and
// editor text that never moves except for what the user asked for (Edit override / Back).
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s2-shots');
await mkdir(shots, { recursive: true });
const port = 5292;
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
/** Controls in the pane header and the pinned rows: text must fit, and no control wraps its label. */
const clipped = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[role="group"][aria-label="Editor tools"] button, [role="group"][aria-label="Editor tools"] select, [aria-label="Preview"] button',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible')
          return true;
        const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
        return el.tagName === 'BUTTON' && r.height > Math.max(2 * line + 8, 50);
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
  );

async function open(theme, viewport, path, { phone = false } = {}) {
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
  });
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${path}`);
  await page.locator('.cm-content').first().waitFor();
  return { context, page, errors };
}

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    for (const [width, height, phone] of [
      [1440, 900, false],
      [1280, 800, false],
      [800, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      // Derived enhanced version (no override), then the override page.
      for (const [name, path] of [
        ['derived', '/t/1000?lang=en'],
        ['override', '/t/1001?lang=en'],
        ['blank', '/t/1002?lang=en'],
      ]) {
        const { context, page, errors } = await open(theme, { width, height }, path, { phone });
        const label = `${theme} ${width} ${name}`;
        await noOverflow(page, label);
        assert.deepEqual(await clipped(page), [], `${label}: controls clip or wrap their text`);
        // One editor per item, never a duplicate.
        assert.equal(await page.locator('.cm-editor').count(), 1, `${label}: exactly one editor`);
        const buttons = await page
          .locator('[role="group"][aria-label="Editor tools"] button')
          .allTextContents();
        if (name === 'derived') {
          // Stored form became the maintainers' "Grouped N" popover (c25439eb): the base and
          // its derived enhanced version are the two perks that open this entry.
          assert.ok(
            buttons.some((text) => /Grouped\s*2$/.test(text.trim())),
            `${label}: Grouped 2 (${buttons})`,
          );
          assert.ok(
            !buttons.some((text) => text.includes('Edit override')),
            `${label}: no override`,
          );
        }
        if (name === 'override')
          assert.ok(
            buttons.some((text) => text.includes('Edit override')),
            `${label}: override`,
          );
        if (name === 'blank') {
          assert.ok(
            !buttons.some((text) => text.includes('Edit override')),
            `${label}: blank copy`,
          );
        }
        if (!phone && width >= 1280) {
          // The markup row (30px, open by default since overhaul P2 step 8) sits above the
          // text; the 80px budget covers the app header and the pane header.
          const top = (await firstLine(page)).top;
          const row = await page.locator('[data-markup-row]').boundingBox();
          const budget = 80 + (row ? Math.round(row.height) + 1 : 0);
          if (top > budget) await page.screenshot({ path: out(`FAIL-${name}-${width}`) });
          assert.ok(top <= budget, `${label}: editor first line ${top}px from the top (${budget})`);
        }
        if (width === 800) {
          // 701-850: the pane header toggles the main slot; nothing stacks under the editor.
          const toggles = await page.locator('[data-toggles] button').allTextContents();
          assert.ok(toggles.includes('Compendium'), `${label}: Compendium toggle (${toggles})`);
          await page.screenshot({ path: out(`${name}-${width}`) });
          const before = await page.locator('.cm-content').first().boundingBox();
          await page.getByRole('button', { name: 'Compendium', exact: true }).click();
          const hiddenEditor = await page.locator('.cm-content').first().isHidden();
          assert.ok(hiddenEditor, `${label}: the editor slot is swapped out`);
          await page.screenshot({ path: out(`${name}-${width}-compendium`) });
          await page.getByRole('button', { name: 'Compendium', exact: true }).click();
          const after = await page.locator('.cm-content').first().boundingBox();
          assert.equal(Math.round(after.y), Math.round(before.y), `${label}: editor back in place`);
        } else {
          await page.screenshot({ path: out(`${name}-${width}`) });
        }
        assert.deepEqual(errors, [], `${label}: no page errors`);
        await context.close();
      }
    }

    // Override round trip at 1280: the base editor keeps its text and caret; popovers move nothing.
    {
      const { context, page, errors } = await open(
        theme,
        { width: 1280, height: 800 },
        '/t/1001?lang=en',
      );
      const label = `${theme} override round trip`;
      await page.locator('.cm-content').first().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' typed');
      // A long text scrolls inside the editor: the page does not grow, the first line stays put.
      const boxTop = () =>
        page
          .locator('.cm-editor')
          .first()
          .evaluate((el) => Math.round(el.getBoundingClientRect().top));
      const topBeforeLong = await boxTop();
      for (let i = 0; i < 70; i++) await page.keyboard.press('Enter');
      const fit = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        return main.scrollHeight - main.clientHeight;
      });
      assert.ok(fit <= 2, `${label}: long text made the page scroll (${fit}px)`);
      assert.equal(await boxTop(), topBeforeLong, `${label}: long text moved the editor`);
      for (let i = 0; i < 70; i++) await page.keyboard.press('Backspace');
      const baseText = await page.locator('.cm-content').first().innerText();
      const topBefore = await firstLine(page);
      // The Details button is gone (703af7ac, FB19): the last edit sits on the History row in the
      // left column, which expands in place without moving the editor text.
      const history = page.getByRole('button', { name: 'History', exact: true });
      await history.click();
      assert.equal(await history.getAttribute('aria-expanded'), 'true', `${label}: History opens`);
      assert.deepEqual(await firstLine(page), topBefore, `${label}: History moved the text`);
      await page.screenshot({ path: out('history-open-1280') });
      await history.click();
      assert.equal(
        await history.getAttribute('aria-expanded'),
        'false',
        `${label}: History closes`,
      );
      await page.getByRole('button', { name: 'Edit override' }).click();
      assert.equal(await page.locator('.cm-editor').count(), 2, `${label}: base stays mounted`);
      assert.match(
        await page.locator('[role="group"][aria-label="Editor tools"]').innerText(),
        /Enhanced override/,
      );
      assert.match(await page.locator('.cm-content').nth(1).innerText(), /Enhanced override text/);
      await page.screenshot({ path: out('override-open-1280') });
      await page.getByRole('button', { name: 'Back to base' }).click();
      assert.equal(
        await page.locator('.cm-content').first().innerText(),
        baseText,
        `${label}: base text kept`,
      );
      assert.deepEqual(await firstLine(page), topBefore, `${label}: base editor back in place`);
      // Maintainer: "Grouped 2" on a derived version lists the base and its enhanced version in
      // a popover (it replaced Stored form, c25439eb) and moves nothing.
      await page.evaluate(() => {
        window.location.hash = '#/t/1000?lang=en';
      });
      await page.locator('.cm-content').first().waitFor();
      const groupedBefore = await firstLine(page);
      await page.getByRole('button', { name: /Grouped/ }).click();
      const grouped = page.getByRole('dialog', { name: 'Grouped manifest perks' });
      await grouped.waitFor();
      const groupedText = await grouped.innerText();
      assert.match(groupedText, /1000/, `${label}: grouped lists the base`);
      assert.match(groupedText, /2001/, `${label}: grouped lists the enhanced version`);
      assert.deepEqual(
        await firstLine(page),
        groupedBefore,
        `${label}: grouped popover moved text`,
      );
      await page.screenshot({ path: out('grouped-1280') });
      await page.keyboard.press('Escape');
      await grouped.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }

    // Phone: Editor / Preview / Compendium / Reports views, panels mounted, equal touch-size tabs.
    {
      const { context, page } = await open(theme, { width: 390, height: 844 }, '/t/1001?lang=en', {
        phone: true,
      });
      const tabs = await page
        .locator('[role="tab"]')
        .evaluateAll((els) =>
          els.map((el) => [el.textContent, Math.round(el.getBoundingClientRect().height)]),
        );
      assert.deepEqual(
        tabs.map(([text]) => text),
        ['Editor', 'Preview', 'Compendium', 'Reports'],
      );
      // Compact touch size (the default since f126ec68) is 36px at 100% and follows the
      // interface scale; "Touch control size: Large" restores 44px. The tabs share one height.
      assert.ok(
        tabs.every(([, height]) => height >= 36 && height === tabs[0][1]),
        `phone tabs 36px (${tabs})`,
      );
      await page.getByRole('tab', { name: 'Preview' }).click();
      assert.equal(await page.locator('.cm-editor').count(), 1, 'editor stays mounted');
      await noOverflow(page, `${theme} phone preview`);
      await page.screenshot({ path: out('phone-preview-390') });
      await page.getByRole('tab', { name: 'Compendium' }).click();
      await noOverflow(page, `${theme} phone compendium`);
      await page.screenshot({ path: out('phone-compendium-390') });
      await context.close();
    }

    // Translator view: the same left column and one editor, English as a swap in the main slot.
    {
      const { context, page } = await open(theme, { width: 800, height: 800 }, '/t/1000?lang=de');
      await page.evaluate(() => window.shellFixture.role('translator'));
      await page.locator('.cm-content').first().waitFor();
      const toggles = await page.locator('[data-toggles] button').allTextContents();
      // The Reports pane (every role) joined the swaps after this harness was written.
      assert.deepEqual(toggles, ['English', 'Reports']);
      await noOverflow(page, `${theme} translator 800`);
      await page.screenshot({ path: out('translator-800') });
      await context.close();
    }
  }
  knownDefectSummary();
  console.log('Editor page browser checks passed.');
} finally {
  await browser.close();
  await server.close();
}
