/* global document, window, getComputedStyle, NodeFilter */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';
import { collectPageErrors, knownDefectSummary } from './known-defects.mjs';

// Step 5b adds: the "Sheet colours" header toggle (sheet backgrounds vs the editor surface, light
// theme raised, text AA), the pane following the interface scale (85 / 150 %), and translators
// seeing the read-only sentence once (status bar) with only a short badge in the pane header.
// The Compendium / English right pane (overhaul P2 step 5) in the real shell on synthetic data:
// both themes, 1440 / 1280 / 1024 / 800 / 768 / 390. One 28px pane header (44px on touch), a body
// that scrolls on its own, the Changes / Before-After switch in the header when the pane is wide
// and above the diff when it is narrow, the device zoom (70-100 %), no horizontal overflow, no
// clipped or wrapping controls, and editor text that never moves for any of it.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-p2s5b-shots');
await mkdir(shots, { recursive: true });
const port = 5295;
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
        // Content of a horizontal scroller inside the window (the markup row) scrolls, not overflows.
        const scroller = (node) => {
          for (let up = node.parentElement; up && up !== document.body; up = up.parentElement)
            if (['auto', 'scroll'].includes(getComputedStyle(up).overflowX))
              return up.getBoundingClientRect().right <= window.innerWidth + 1;
          return false;
        };
        return (
          r.width > 0 &&
          r.right > window.innerWidth + 1 &&
          !el.closest('[hidden]') &&
          !el.closest('.cm-scroller') &&
          !scroller(el)
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};
/** The pane header's controls: nothing clips its own text, nothing wraps, header stays one line. */
const clipped = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-label="Compendium tools"] *, [aria-label="English tools"] *',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.classList.contains('sr-only')) return false;
        // A flex child pushed past its overflow-hidden header is cut without any scrollWidth.
        const box = el.closest('[aria-label$=" tools"]').getBoundingClientRect();
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) return true;
        const style = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && style.overflow !== 'visible') return true;
        if (el.tagName === 'SELECT') return false;
        const line = parseFloat(style.lineHeight) || 16;
        return (
          ['BUTTON', 'H3', 'OUTPUT', 'LABEL'].includes(el.tagName) &&
          r.height >
            Math.max(
              2 * line + 8,
              50 * (parseFloat(getComputedStyle(document.documentElement).fontSize) / 16),
            )
        );
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
  );
const headerHeight = (page, label) =>
  page.evaluate(
    (name) =>
      Math.round(
        document.querySelector(`[aria-label="${name} tools"]`).getBoundingClientRect().height,
      ),
    label,
  );

async function open(
  theme,
  viewport,
  path,
  { phone = false, role = 'maintainer', rightWidth } = {},
) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (rightWidth)
    await context.addInitScript((width) => {
      localStorage.setItem(
        'clarity-settings:device:v1',
        JSON.stringify({ panes: { 'editor:right': { width, collapsed: false } } }),
      );
    }, rightWidth);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', collectPageErrors(errors));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate((who) => {
    window.shellFixture.role(who);
    window.shellFixture.variants();
    window.shellFixture.compendiumRows();
    window.shellFixture.outdatedTranslation();
  }, role);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${path}`);
  await page.locator('.cm-content').first().waitFor();
  await page.waitForTimeout(300); // the pane measures itself after layout
  return { context, page, errors };
}

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    // Desktop widths, default pane width: the diff switch sits above the diff.
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 800],
    ]) {
      const { context, page, errors } = await open(theme, { width, height }, '/t/1001?lang=en');
      const label = `${theme} ${width}`;
      const header = page.locator('[aria-label="Compendium tools"]');
      await header.waitFor();
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${label}: pane header is 28px`);
      assert.deepEqual(await clipped(page), [], `${label}: header controls clip or wrap`);
      await noOverflow(page, label);
      assert.equal(await header.locator('h3').textContent(), 'Compendium');
      // The linked row arrives from matching after load (about 0.2 s on a cold production build),
      // so wait for it rather than sampling once.
      await header.getByRole('button', { name: 'Pick other row' }).waitFor({ timeout: 5000 });
      // The Compendium | Reports tabs take the title's place and more room: at the default
      // 384px pane the switch sits above the diff so the zoom stays in view.
      assert.equal(
        await header.locator('[aria-label="Compendium diff view"]').count(),
        0,
        `${label}: the default 384px pane with pane tabs puts the diff switch above the diff`,
      );
      assert.equal(await page.locator('[aria-label="Compendium diff view"]').count(), 1);
      await page.screenshot({ path: out(`compendium-${width}`) });

      // Zoom and the diff view change the pane only: the editor text stays where it is.
      const text = await firstLine(page);
      const zoomed = page.locator('aside[aria-label^="Compendium for"] [data-scale]');
      const before = await zoomed.boundingBox();
      for (let i = 0; i < 3; i++) await header.getByRole('button', { name: 'Smaller' }).click();
      assert.equal(await header.locator('output').textContent(), '70%');
      assert.ok(await header.getByRole('button', { name: 'Smaller' }).isDisabled());
      const after = await zoomed.boundingBox();
      assert.ok(after.height < before.height, `${label}: zoom 70% shrinks the pane body`);
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${label}: header never scales`);
      await page.getByRole('button', { name: 'Before / After' }).click();
      assert.deepEqual(await firstLine(page), text, `${label}: pane controls moved the text`);
      await noOverflow(page, `${label} zoomed before/after`);
      assert.deepEqual(await clipped(page), [], `${label} zoomed: header clips`);
      await page.screenshot({ path: out(`compendium-${width}-zoom70-before-after`) });

      // The body scrolls on its own: the header and the editor stay put.
      for (let i = 0; i < 3; i++) await header.getByRole('button', { name: 'Larger' }).click();
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      const headerTop = await header.evaluate((el) => Math.round(el.getBoundingClientRect().top));
      const scrolled = await page.evaluate(() => {
        const pane = document.querySelector('aside[aria-label^="Compendium for"]');
        const scroller = pane.lastElementChild;
        scroller.scrollTop = 9999;
        return { top: scroller.scrollTop, fits: scroller.scrollHeight > scroller.clientHeight };
      });
      assert.ok(scrolled.fits && scrolled.top > 0, `${label}: the body scrolls (${scrolled.top})`);
      assert.equal(
        await header.evaluate((el) => Math.round(el.getBoundingClientRect().top)),
        headerTop,
        `${label}: header stays while the body scrolls`,
      );
      assert.deepEqual(await firstLine(page), text, `${label}: body scroll moved the text`);
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }

    // A wide pane (560px): the diff switch moves into the header.
    {
      const { context, page } = await open(theme, { width: 1440, height: 900 }, '/t/1001?lang=en', {
        rightWidth: 560,
      });
      const header = page.locator('[aria-label="Compendium tools"]');
      await header.waitFor();
      assert.equal(await header.locator('[aria-label="Compendium diff view"]').count(), 1);
      assert.equal(await page.locator('[aria-label="Compendium diff view"]').count(), 1);
      assert.equal(await headerHeight(page, 'Compendium'), 28);
      assert.deepEqual(await clipped(page), [], `${theme} wide pane: header clips`);
      await noOverflow(page, `${theme} wide pane`);
      await page.screenshot({ path: out('compendium-1440-wide-pane') });
      await context.close();
    }

    // The minimum pane (320px) keeps everything on one header line.
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 }, '/t/1001?lang=en', {
        rightWidth: 320,
      });
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${theme} 320 pane header`);
      assert.equal(
        await page
          .locator('[aria-label="Compendium tools"] [aria-label="Compendium diff view"]')
          .count(),
        0,
        `${theme} 320 pane: the diff switch sits above the diff`,
      );
      assert.equal(await page.locator('[aria-label="Compendium diff view"]').count(), 1);
      assert.deepEqual(await clipped(page), [], `${theme} 320 pane: header clips`);
      await noOverflow(page, `${theme} 320 pane`);
      await page.screenshot({ path: out('compendium-320-pane') });
      await context.close();
    }

    // The row picker opens in the pane with the same control style, fields stacked at full width.
    for (const rightWidth of [384, 320]) {
      const { context, page } = await open(theme, { width: 1280, height: 800 }, '/t/1001?lang=en', {
        rightWidth,
      });
      const label = `${theme} picker ${rightWidth}`;
      await page
        .locator('[aria-label="Compendium tools"]')
        .getByRole('button', { name: 'Pick other row' })
        .click();
      const picker = page.getByRole('region', { name: 'Link a Compendium row' });
      await picker.waitFor();
      const text = await firstLine(page);
      const metrics = await picker.evaluate((section) => {
        const pane = section.closest('aside').lastElementChild.getBoundingClientRect();
        const select = section.querySelector('label select').getBoundingClientRect();
        const heading = parseFloat(getComputedStyle(section.querySelector('h3')).fontSize);
        const buttons = [...section.querySelectorAll(':scope > ul button')].map((b) =>
          Math.round(b.getBoundingClientRect().height),
        );
        return { pane: pane.width, select: select.width, selectH: select.height, heading, buttons };
      });
      assert.ok(
        metrics.select >= metrics.pane - 24,
        `${label}: fields span the pane (${JSON.stringify(metrics)})`,
      );
      assert.equal(Math.round(metrics.selectH), 24, `${label}: fields are 24px`);
      assert.ok(metrics.heading <= 14, `${label}: picker heading at pane scale`);
      assert.ok(
        metrics.buttons.every((h) => h === 24),
        `${label}: buttons are 24px (${metrics.buttons})`,
      );
      await noOverflow(page, label);
      assert.deepEqual(await clipped(page), [], `${label}: header clips`);
      assert.deepEqual(await firstLine(page), text, `${label}: the picker moved the text`);
      await page.screenshot({ path: out(`picker-${rightWidth}`) });
      await context.close();
    }

    // 800 and 768: the pane header's toggle swaps the main slot to the Compendium.
    for (const width of [800, 768]) {
      const { context, page } = await open(theme, { width, height: 800 }, '/t/1001?lang=en');
      const text = await firstLine(page);
      await page.getByRole('button', { name: 'Compendium', exact: true }).click();
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      await noOverflow(page, `${theme} ${width} compendium`);
      assert.deepEqual(await clipped(page), [], `${theme} ${width}: header clips`);
      await page.screenshot({ path: out(`compendium-${width}-swapped`) });
      await page.getByRole('button', { name: 'Compendium', exact: true }).click();
      assert.deepEqual(await firstLine(page), text, `${theme} ${width}: editor back in place`);
      await context.close();
    }

    // Phone: the Compendium tab shows the pane with 44px controls.
    {
      const { context, page } = await open(theme, { width: 390, height: 844 }, '/t/1001?lang=en', {
        phone: true,
      });
      await page.getByRole('tab', { name: 'Compendium' }).click();
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      const height = await headerHeight(page, 'Compendium');
      assert.ok(height >= 44, `${theme} phone header ${height}px`);
      assert.deepEqual(await clipped(page), [], `${theme} phone: header clips`);
      await noOverflow(page, `${theme} phone compendium`);
      await page.screenshot({ path: out('compendium-390') });
      await context.close();
    }

    // Sheet colours: the header toggle switches the cell between the sheet's own background and
    // the editor surface (the dark cell, raised a little in the light theme); text stays AA.
    {
      const { context, page, errors } = await open(
        theme,
        { width: 1280, height: 800 },
        '/t/1001?lang=en',
      );
      const label = `${theme} sheet colours`;
      const header = page.locator('[aria-label="Compendium tools"]');
      await header.waitFor();
      const toggle = header.getByRole('button', { name: 'Sheet colours' });
      assert.equal(
        await toggle.getAttribute('aria-pressed'),
        'true',
        `${label}: default is sheet colours`,
      );
      assert.equal(await headerHeight(page, 'Compendium'), 28, `${label}: header 28px`);
      const cellInfo = () =>
        page.evaluate(() => {
          const cell = document.querySelector('aside[aria-label^="Compendium for"] [data-surface]');
          const lum = (rgb) => {
            const [r, g, b] = rgb
              .match(/\d+/g)
              .slice(0, 3)
              .map((v) => {
                const c = Number(v) / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ratio = (a, b) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
          };
          const bg = getComputedStyle(cell).backgroundColor;
          const colours = [...cell.querySelectorAll('span[style*="color"]')].map(
            (el) => getComputedStyle(el).color,
          );
          return {
            surface: cell.dataset.surface,
            bg,
            colours,
            minContrast: Math.min(
              ...colours.map((c) => ratio(c, bg)),
              ratio(getComputedStyle(cell).color, bg),
            ),
          };
        });
      const text = await firstLine(page);
      const sheet = await cellInfo();
      assert.equal(sheet.surface, 'sheet');
      assert.equal(sheet.bg, 'rgb(232, 220, 200)', `${label}: the sheet's own background`);
      assert.deepEqual(
        sheet.colours.slice(0, 1),
        ['rgb(120, 63, 4)'],
        `${label}: sheet text colour kept`,
      );
      await page.screenshot({ path: out('sheet-colours-on') });
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      const surface = await cellInfo();
      assert.equal(surface.surface, 'editor');
      assert.equal(
        surface.bg,
        theme === 'light' ? 'rgb(53, 58, 85)' : 'rgb(26, 27, 41)',
        `${label}: editor surface (light raised a little)`,
      );
      assert.ok(
        surface.minContrast >= 4.5,
        `${label}: text AA on the editor surface (${surface.minContrast})`,
      );
      assert.deepEqual(await firstLine(page), text, `${label}: toggle moved the text`);
      assert.deepEqual(await clipped(page), [], `${label}: header clips`);
      await noOverflow(page, label);
      await page.screenshot({ path: out('sheet-colours-off') });
      // Remembered on this device across a reload.
      await page.reload();
      await page.locator('header').first().waitFor();
      await page.evaluate(() => {
        window.shellFixture.role('maintainer');
        window.shellFixture.variants();
        window.shellFixture.compendiumRows();
      });
      await page.evaluate(() => {
        window.location.hash = '#/t/1001?lang=en';
      });
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Sheet colours' }).getAttribute('aria-pressed'),
        'false',
        `${label}: choice remembered`,
      );
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }

    // The pane follows the interface scale: header 28px x scale, no overflow or clipping at either
    // end, and the Changes / Before-After switch moves above the diff when the pane runs out of room.
    for (const scale of [85, 150]) {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1000 },
        colorScheme: theme,
      });
      await context.addInitScript((value) => {
        localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
      }, scale);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', collectPageErrors(errors));
      await page.goto(url);
      await page.locator('header').first().waitFor();
      await page.evaluate(() => {
        window.shellFixture.role('maintainer');
        window.shellFixture.variants();
        window.shellFixture.compendiumRows();
      });
      await page.evaluate(() => {
        window.location.hash = '#/t/1001?lang=en';
      });
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      await page.waitForTimeout(300);
      const label = `${theme} scale ${scale}`;
      const height = await headerHeight(page, 'Compendium');
      assert.equal(
        height,
        Math.round((28 * scale) / 100),
        `${label}: pane header follows the scale (${height}px)`,
      );
      const metrics = await page.evaluate(() => {
        const header = document.querySelector('[aria-label="Compendium tools"]');
        const buttons = [...header.querySelectorAll('button:not([role="tab"])')].map((b) =>
          Math.round(b.getBoundingClientRect().height),
        );
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const body = document.querySelector('aside[aria-label^="Compendium for"] [data-scale] p');
        return { buttons, root, pad: parseFloat(getComputedStyle(body).marginBottom) };
      });
      assert.ok(
        metrics.buttons.every((h) => h === Math.round((24 * scale) / 100)),
        `${label}: header controls follow the scale (${metrics.buttons})`,
      );
      assert.equal(
        metrics.pad,
        (6 * metrics.root) / 16,
        `${label}: body spacing follows the scale`,
      );
      assert.deepEqual(await clipped(page), [], `${label}: header clips`);
      await noOverflow(page, label);
      // The pane's width follows the scale (384 design px), so the header keeps its room.
      const pane = await page.evaluate(() =>
        Math.round(
          document.querySelector('aside[aria-label^="Compendium for"]').getBoundingClientRect()
            .width,
        ),
      );
      assert.ok(
        Math.abs(pane - (384 * scale) / 100) <= 1.5,
        `${label}: pane is ${pane}px, expected ${(384 * scale) / 100}`,
      );
      assert.equal(
        await page
          .locator('[aria-label="Compendium tools"] [aria-label="Compendium diff view"]')
          .count(),
        0,
        `${label}: with pane tabs the default pane puts the diff switch above the diff`,
      );
      await page.screenshot({ path: out(`scale-${scale}`) });
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }

    // Phone at the largest scale: the title gives way, nothing is cut at the right edge.
    for (const scale of [100, 150]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
        hasTouch: true,
        isMobile: true,
      });
      await context.addInitScript((value) => {
        localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
      }, scale);
      const page = await context.newPage();
      await page.goto(url);
      await page.locator('header').first().waitFor();
      await page.evaluate(() => {
        window.shellFixture.role('maintainer');
        window.shellFixture.variants();
        window.shellFixture.compendiumRows();
      });
      await page.evaluate(() => {
        window.location.hash = '#/t/1001?lang=en';
      });
      await page.getByRole('tab', { name: 'Compendium' }).click();
      await page.locator('[aria-label="Compendium tools"]').waitFor();
      await page.waitForTimeout(300);
      const label = `${theme} phone scale ${scale}`;
      assert.deepEqual(await clipped(page), [], `${label}: header cuts a control`);
      assert.ok(await page.getByRole('button', { name: 'Larger' }).isVisible());
      await noOverflow(page, label);
      await page.screenshot({ path: out(`phone-scale-${scale}`) });
      await context.close();
    }

    // A translator on English: the pane header badge only says "Read-only"; the sentence is the
    // status bar's alone (and the badge's tooltip).
    {
      const { context, page } = await open(theme, { width: 1280, height: 800 }, '/t/1000?lang=en', {
        role: 'translator',
      });
      const label = `${theme} translator read-only`;
      const badge = page.locator('[role="status"][title^="Read-only"]').first();
      await badge.waitFor();
      assert.equal((await badge.innerText()).trim().split('\n')[0], 'Read-only');
      const sentence = await badge.getAttribute('title');
      assert.match(sentence, /you can translate/);
      const bar = await page.locator('[data-status-reason]').innerText();
      assert.equal(bar.trim(), sentence, `${label}: the status bar has the sentence`);
      const visible = await page.evaluate((needle) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let count = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent.includes(needle) && node.parentElement.offsetParent) count++;
        }
        return count;
      }, sentence);
      assert.equal(visible, 1, `${label}: the sentence is on screen once`);
      await page.screenshot({ path: out('translator-read-only') });
      await context.close();
    }

    // Translator: the English pane has its header and a "Shows" select; no Compendium.
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      const { context, page, errors } = await open(theme, { width, height }, '/t/1000?lang=de', {
        phone,
        role: 'translator',
      });
      const label = `${theme} translator ${width}`;
      if (width === 768) await page.getByRole('button', { name: 'English', exact: true }).click();
      if (phone) await page.getByRole('tab', { name: 'English' }).click();
      const header = page.locator('[aria-label="English tools"]');
      await header.waitFor();
      assert.equal(await header.locator('h3').textContent(), 'English');
      const select = header.getByLabel('English shows');
      assert.equal(await select.inputValue(), 'changes');
      assert.equal(await page.locator('[aria-label^="Compendium"]').count(), 0, 'no Compendium');
      const h = await headerHeight(page, 'English');
      assert.ok(phone ? h >= 36 : h === 28, `${label}: header ${h}px (touch: --tap, 36px)`);
      assert.deepEqual(await clipped(page), [], `${label}: header clips`);
      await noOverflow(page, label);
      const text = await firstLine(page);
      await select.selectOption('current');
      assert.deepEqual(await firstLine(page), text, `${label}: Shows moved the text`);
      assert.match(
        await page.locator('aside[aria-label="English source"]').innerText(),
        /deals/,
        `${label}: current English shown`,
      );
      await page.screenshot({ path: out(`english-${width}`) });
      assert.deepEqual(errors, [], `${label}: page errors`);
      await context.close();
    }
  }
  knownDefectSummary();
  console.log('Compendium pane browser checks passed.');
} finally {
  await browser.close();
  await server.close();
}
