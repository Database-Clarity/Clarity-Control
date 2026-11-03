/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Overhaul P2 step 8 in the real shell on synthetic data: the markup row (Ctrl+. is the only thing
// that changes the layout), the All popover and the suggestion chips. Both themes at 390 / 768 /
// 1280: zero horizontal overflow, nothing clipped, nothing wrapping inside a control, real
// preview icons on the buttons, the chip never over a selected character and never moving text.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s8-shots');
await mkdir(shots, { recursive: true });
const port = 5298;
const url = `http://127.0.0.1:${port}/test/shell.html`;

process.env.VITE_API_URL = 'https://api.fixture.invalid';
const server = await createServer({
  root: web,
  configLoader: 'runner',
  server: { host: '127.0.0.1', port, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const firstLine = (page) =>
  page.evaluate(() =>
    Math.round(
      document.querySelector('.cm-line').getBoundingClientRect().top +
        window.scrollY +
        document.querySelector('.cm-scroller').scrollTop,
    ),
  );
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
          !el.closest('[data-markup-row] [role=toolbar]')
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};

async function open(theme, viewport, phone) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
      const row = page.locator('[data-markup-row]');
      const content = page.locator('.cm-content');

      // Closed by default; Ctrl+. (or the header button) opens it, and that is the only reflow.
      assert.equal(await row.count(), 0, `${label}: the row starts closed`);
      const closedLine = await firstLine(page);
      if (phone) await page.getByRole('button', { name: /Markup tools/ }).click();
      else await page.keyboard.press('Control+.');
      await row.waitFor();
      const rowBox = await row.boundingBox();
      const expectedHeight = phone ? 52 : 30;
      assert.ok(
        Math.abs(rowBox.height - expectedHeight) <= 1,
        `${label}: row is ${expectedHeight}px (${rowBox.height})`,
      );
      const openLine = await firstLine(page);
      assert.ok(
        Math.abs(openLine - closedLine - expectedHeight - 1) <= 2,
        `${label}: opening the row shifted the text by ${openLine - closedLine}, not its own height`,
      );

      // One line, real icons on the buttons, every control inside the row's height.
      const facts = await page.evaluate(() => {
        const toolbar = document.querySelector('[data-markup-row] [role=toolbar]');
        const buttons = [...toolbar.querySelectorAll('[data-row-button]')];
        const tops = new Set(
          buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
        );
        const icons = buttons
          .filter((button) => button.dataset.entry.startsWith('icon:'))
          .map((button) => {
            const glyph = button.querySelector('[data-icon]');
            const image = getComputedStyle(glyph, '::before').backgroundImage;
            const box = button.getBoundingClientRect();
            return { name: glyph.dataset.icon, image: image !== 'none', box: box.width > 0 };
          });
        const arrow = buttons.find((button) => button.dataset.entry === 'enhanced-arrow');
        return {
          lines: tops.size,
          count: buttons.length,
          icons,
          more: toolbar.scrollWidth > toolbar.clientWidth,
          arrowSvg: Boolean(arrow.querySelector('svg')),
          clipped: buttons
            .filter((button) => button.scrollWidth > button.clientWidth + 1)
            .map((button) => button.dataset.entry),
          all: [...document.querySelectorAll('[data-markup-row] button')]
            .filter((button) => button.textContent.trim() === 'All')
            .map((button) => {
              const box = button.getBoundingClientRect();
              return { right: box.right, inside: box.right <= window.innerWidth + 0.5 };
            }),
        };
      });
      assert.equal(facts.lines, 1, `${label}: the buttons sit on one line`);
      assert.equal(facts.icons.length, 15, `${label}: fifteen icons`);
      assert.ok(
        facts.icons.every((icon) => icon.image && icon.box),
        `${label}: every icon draws the preview artwork ${JSON.stringify(facts.icons.filter((i) => !i.image))}`,
      );
      assert.ok(facts.arrowSvg, `${label}: filled enhanced arrow`);
      assert.deepEqual(facts.clipped, [], `${label}: clipped button text`);
      assert.ok(
        facts.all.length === 1 && facts.all[0].inside,
        `${label}: All stays pinned in view`,
      );
      if (phone) assert.ok(facts.more, `${label}: the row scrolls sideways on a phone`);
      await noOverflow(page, `${label} row open`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-row.png` });

      // Scrolling the row sideways moves nothing else.
      if (facts.more) {
        const before = await firstLine(page);
        await page.evaluate(() => {
          document.querySelector('[data-markup-row] [role=toolbar]').scrollLeft = 400;
        });
        assert.equal(await firstLine(page), before, `${label}: row scroll moved the text`);
        await page.screenshot({ path: `${shots}/${theme}-${width}-row-scrolled.png` });
        await page.evaluate(() => {
          document.querySelector('[data-markup-row] [role=toolbar]').scrollLeft = 0;
        });
      }

      // Inserting with the row does not move the first line, and the caret comes back.
      await content.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n\nGains ');
      const settled = await firstLine(page);
      await page.locator('[data-entry="pair"]').click();
      assert.ok(
        (await content.innerText()).includes('<pve value /> <pvp [value] />'),
        `${label}: pair inserted`,
      );
      assert.equal(await firstLine(page), settled, `${label}: inserting moved the first line`);
      assert.equal(
        await page.evaluate(() => document.activeElement?.classList.contains('cm-content')),
        true,
        `${label}: the text kept the caret after inserting`,
      );
      await page.keyboard.press('Control+z');

      // All popover: everything, grouped, no tables; fits the window; Esc closes.
      await page.getByRole('button', { name: /^All/ }).click();
      const all = page.locator('[data-all-popover]');
      await all.waitFor();
      const popover = await page.evaluate(() => {
        const surface = document.querySelector('[data-all-popover]').closest('[role=dialog]');
        const box = surface.getBoundingClientRect();
        const groups = [...surface.querySelectorAll('[role=group]')].map((g) =>
          g.getAttribute('aria-label'),
        );
        const wrapped = [...surface.querySelectorAll('[data-all-button]')]
          .filter((chip) => chip.getBoundingClientRect().height > 50)
          .map((chip) => chip.textContent);
        return {
          inside:
            box.left >= -1 &&
            box.right <= window.innerWidth + 1 &&
            box.top >= -1 &&
            box.bottom <= window.innerHeight + 1,
          groups,
          table: /table/i.test(surface.textContent),
          wrapped,
        };
      });
      assert.ok(popover.inside, `${label}: the All popover fits the window`);
      assert.ok(!popover.table, `${label}: no table options`);
      assert.deepEqual(popover.wrapped, [], `${label}: option wrapped inside its button`);
      assert.ok(popover.groups.includes('Icons') && popover.groups.includes('Values'));
      await noOverflow(page, `${label} All popover`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-all.png` });
      await page.keyboard.type('stasis');
      assert.ok(
        (await all.locator('[data-all-button]').count()) < 8,
        `${label}: the filter narrows the list`,
      );
      await page.keyboard.press('Escape');
      assert.equal(await all.count(), 0, `${label}: Esc closes the popover`);

      // Chip for a typed icon word: floats below the caret line, moves nothing, Enter inserts.
      await content.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n');
      const beforeChip = await firstLine(page);
      await page.keyboard.type('Kinetic');
      const chip = page.locator('[data-suggest-chip]');
      await chip.waitFor();
      assert.equal(await firstLine(page), beforeChip, `${label}: the chip moved the text`);
      const geometry = await page.evaluate(() => {
        const box = document.querySelector('[data-suggest-chip]').getBoundingClientRect();
        const caret = document.querySelector('.cm-cursor')?.getBoundingClientRect();
        return {
          box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
          caret: caret && { top: caret.top, bottom: caret.bottom },
          inside: box.left >= 0 && box.right <= window.innerWidth + 1,
        };
      });
      assert.ok(geometry.inside, `${label}: the chip is inside the window`);
      assert.ok(
        !geometry.caret ||
          geometry.box.top >= geometry.caret.bottom - 0.5 ||
          geometry.box.bottom <= geometry.caret.top + 0.5,
        `${label}: the chip is over the caret line ${JSON.stringify(geometry)}`,
      );
      await page.screenshot({ path: `${shots}/${theme}-${width}-chip.png` });
      await page.keyboard.press('Escape');
      assert.equal(await chip.count(), 0, `${label}: Esc dismisses the chip`);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      assert.equal(await chip.count(), 0, `${label}: moving the caret does not bring it back`);
      for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('Arc');
      await chip.waitFor();
      await page.keyboard.press('Enter');
      assert.ok((await content.innerText()).includes('<arc/>Arc'), `${label}: Enter took the chip`);

      // Chip for a selection: never over any selected character.
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n6.5 [5]');
      for (let i = 0; i < '6.5 [5]'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
      await chip.waitFor();
      const selection = await page.evaluate(() => {
        const box = document.querySelector('[data-suggest-chip]').getBoundingClientRect();
        const selected = [...document.querySelectorAll('.cm-selectionBackground')].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        });
        const overlaps = selected.filter(
          (r) =>
            box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top,
        );
        return { overlaps: overlaps.length, selected: selected.length };
      });
      assert.ok(selection.selected > 0, `${label}: the selection is drawn`);
      assert.equal(selection.overlaps, 0, `${label}: the chip covers selected text`);
      const chipBar = await page.evaluate(() => {
        const box = document.querySelector('[data-suggest-chip]').getBoundingClientRect();
        const bar = document.querySelector('[data-editor-status]').getBoundingClientRect();
        return (
          box.left < bar.right &&
          box.right > bar.left &&
          box.top < bar.bottom &&
          box.bottom > bar.top
        );
      });
      assert.equal(chipBar, false, `${label}: the chip sits on the status bar`);
      // Scrolling the page (a phone) never leaves the chip over the selection.
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
      const afterScroll = await page.evaluate(() => {
        const chip = document.querySelector('[data-suggest-chip]');
        if (!chip || chip.style.visibility === 'hidden') return 0;
        const box = chip.getBoundingClientRect();
        return [...document.querySelectorAll('.cm-selectionBackground')].filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top
          );
        }).length;
      });
      assert.equal(afterScroll, 0, `${label}: scrolling put the chip over the selection`);
      await noOverflow(page, `${label} selection chip`);
      await page.screenshot({ path: `${shots}/${theme}-${width}-chip-selection.png` });
      await page.keyboard.press('Enter');
      assert.ok(
        (await content.innerText()).includes('<pve 6.5 /> <pvp [5] />'),
        `${label}: Enter applied the transform`,
      );

      // Ctrl+. again closes the row; the text returns to where it was.
      if (phone) await page.getByRole('button', { name: /Markup tools/ }).click();
      else await page.keyboard.press('Control+.');
      await page.locator('[data-markup-row]').waitFor({ state: 'detached' });
      assert.equal(
        await firstLine(page),
        closedLine,
        `${label}: closing the row restores the text`,
      );
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }
  console.log('markup row browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
