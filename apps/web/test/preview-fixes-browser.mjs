/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { compendiumHeader, knownDefectSummary } from './known-defects.mjs';

// Preview feedback fixes 1 in the real shell on synthetic data: find & replace at the top of the
// editor (sized with the interface scale, kept across tooltip navigation), the compact All
// popover with separate variable groups, and the interface-scale slider that no longer moves under
// the pointer. Both themes, 390 / 768 / 1280, interface scale 85 and 150.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/preview-fixes-1-shots');
await mkdir(shots, { recursive: true });
const port = 5299;
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

const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.right > window.innerWidth + 1 &&
        !el.closest('[hidden]') &&
        !el.closest('.cm-scroller') &&
        // The editor status bar's own buttons are outside this change (they wrap in its box).
        !el.closest('[class*=StatusBar]') &&
        !String(el.className).includes('_suggest_') &&
        !el.closest('[data-markup-row] [role=toolbar]') &&
        // Never-seen measuring copies (e.g. the phone tools' fit clip) are not on screen.
        window.getComputedStyle(el).visibility !== 'hidden'
      );
    });
    const name = (el) => `${el.tagName}.${String(el.className).slice(0, 40)}`;
    // Holistic finding 3 pushes the Compendium header's cell scale past the window edge.
    const inHeader = (el) => el.closest('[aria-label="Compendium tools"]');
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      wide: wide
        .filter((el) => !inHeader(el))
        .slice(0, 5)
        .map(name),
      header: wide.filter(inHeader).slice(0, 5).map(name),
    };
  });
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
  compendiumHeader(label, overflow.header);
};

async function open(theme, viewport, phone, scale) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  await context.addInitScript((value) => {
    if (!localStorage.getItem('clarity-settings:device:v1'))
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
  }, scale);
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
      for (const scale of [85, 150]) {
        const label = `${theme} ${width} @${scale}`;
        const tag = `${theme}-${width}-${scale}`;
        const { context, page, errors } = await open(theme, { width, height }, phone, scale);
        // A narrow window limits a large scale so the layout keeps fitting: use what applied.
        const applied = Number(await page.evaluate(() => document.documentElement.dataset.uiScale));
        assert.ok(applied <= scale && applied >= 85, `${label}: scale applied (${applied})`);

        // Markup row + All popover: compact, no label text on icon chips, variables split.
        // The row is open by default now (nobody has hidden it on this device).
        await page.locator('[data-markup-row]').waitFor();
        await page.getByRole('button', { name: /^All/ }).click();
        const all = page.locator('[data-all-popover]');
        await all.waitFor();
        const facts = await all.evaluate((node) => {
          const surface = node.closest('[role=dialog]');
          const box = surface.getBoundingClientRect();
          const chips = [...node.querySelectorAll('[data-all-button]')];
          return {
            bottom: box.bottom,
            left: box.left,
            right: box.right,
            height: box.height,
            chips: chips.length,
            labelled: chips
              .filter((chip) => chip.textContent.trim().length > 26)
              .map((chip) => chip.getAttribute('aria-label')),
            groups: [...node.querySelectorAll('[role=group]')].map((g) =>
              g.getAttribute('aria-label'),
            ),
            retired: chips
              .map((chip) => chip.getAttribute('aria-label'))
              .filter((name) =>
                /^(Blue|Green|Purple|Centre text|Background text|Stack list|catalyst|exotic perk|Center line|Background line|Break spaces line)/.test(
                  name,
                ),
              ),
            clipped: chips
              .filter((chip) => chip.scrollWidth > chip.clientWidth + 1)
              .map((chip) => chip.getAttribute('aria-label')),
          };
        });
        assert.ok(facts.left >= 0 && facts.right <= width + 0.5, `${label}: All fits the window`);
        assert.ok(facts.bottom <= height + 0.5, `${label}: All fits vertically`);
        assert.deepEqual(facts.retired, [], `${label}: retired options absent`);
        assert.deepEqual(facts.labelled, [], `${label}: no long label text on chips`);
        assert.deepEqual(facts.clipped, [], `${label}: no clipped chip`);
        assert.ok(facts.groups.includes('Variables'), `${label}: this tooltip's variables group`);
        await noOverflow(page, `${label} All open`);
        await page.screenshot({ path: `${shots}/${tag}-all.png` });
        await page.keyboard.press('Escape');
        await all.waitFor({ state: 'detached' });

        // Find & replace: a widget over the top right of the text (the text never moves), readable,
        // and it follows to the next tooltip.
        await page.locator('.cm-content').click();
        const textTop = await page.evaluate(
          () => document.querySelector('.cm-line').getBoundingClientRect().top,
        );
        await page.keyboard.press('Control+f');
        const panel = page.locator('.cm-panels-top .cm-search');
        await panel.waitFor();
        const find = await page.evaluate(() => {
          const search = document.querySelector('.cm-panels-top .cm-search');
          const input = search.querySelector('input[name=search]');
          const button = search.querySelector('button[name=next]');
          const firstLine = document.querySelector('.cm-line').getBoundingClientRect();
          return {
            inputSize: parseFloat(getComputedStyle(input).fontSize),
            buttonSize: parseFloat(getComputedStyle(button).fontSize),
            panelBottom: search.getBoundingClientRect().bottom,
            lineTop: firstLine.top,
            bottomPanel: Boolean(document.querySelector('.cm-panels-bottom')),
          };
        });
        assert.equal(find.bottomPanel, false, `${label}: find is not at the bottom`);
        assert.ok(Math.abs(find.lineTop - textTop) < 0.5, `${label}: opening find moves no text`);
        // A phone field is --ctl-text (0.875rem, following the interface scale since f126ec68);
        // only iOS Safari gets a 16px floor (controls.ios-field-text), and this is Chrome.
        const minimum = (phone ? 14 : 12) * (applied / 100) - 0.6;
        assert.ok(
          find.inputSize >= minimum && find.buttonSize >= 12 * (applied / 100) - 0.6,
          `${label}: find text scales (${find.inputSize}px, ${find.buttonSize}px)`,
        );
        await page.locator('.cm-panels-top input[name=search]').fill('the');
        await page.locator('.cm-panels-top button[name=toggleReplace]').click();
        await page.locator('.cm-panels-top input[name=replace]').fill('THE');
        await page.screenshot({ path: `${shots}/${tag}-find.png` });
        await page.evaluate(() => {
          window.location.hash = '#/t/1001?lang=en';
        });
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent);
        await page.locator('.cm-panels-top .cm-search').waitFor();
        assert.equal(await page.locator('.cm-panels-top input[name=search]').inputValue(), 'the');
        assert.equal(await page.locator('.cm-panels-top input[name=replace]').inputValue(), 'THE');
        await page.screenshot({ path: `${shots}/${tag}-find-after-navigation.png` });
        await noOverflow(page, `${label} find open`);

        assert.deepEqual(errors, [], `${label}: page errors`);
        await context.close();
      }
    }
  }

  // The interface scale slider holds still under the pointer during a drag, applies on release.
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme, { width: 1280, height: 800 }, false, 100);
    await page.locator('[data-settings-button]').first().click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.waitFor();
    const slider = dialog.locator('input[type=range]');
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    const popoverBox = await dialog.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    const positions = [];
    for (const f of [0.6, 0.8, 1, 0.9, 0.7]) {
      await page.mouse.move(box.x + box.width * f, box.y + box.height / 2, { steps: 4 });
      positions.push({
        slider: await slider.boundingBox(),
        dialog: await dialog.boundingBox(),
        scale: await page.evaluate(() => document.documentElement.dataset.uiScale),
        value: await slider.inputValue(),
      });
    }
    for (const p of positions) {
      assert.equal(p.scale, '100', `${theme}: nothing rescaled while the thumb is held`);
      assert.deepEqual(p.slider, box, `${theme}: the slider did not move`);
      assert.deepEqual(p.dialog, popoverBox, `${theme}: the popover did not move`);
    }
    assert.notEqual(positions.at(-1).value, '100', `${theme}: the thumb followed the pointer`);
    await page.screenshot({ path: `${shots}/${theme}-slider-dragging.png` });
    await page.mouse.up();
    await page.waitForFunction(() => document.documentElement.dataset.uiScale !== '100');
    const applied = await page.evaluate(() => document.documentElement.dataset.uiScale);
    assert.equal(applied, positions.at(-1).value, `${theme}: applied on release`);
    await page.screenshot({ path: `${shots}/${theme}-slider-released.png` });
    assert.deepEqual(errors, [], `${theme}: page errors`);
    await context.close();
  }
  knownDefectSummary();
  console.log('preview fixes: ok');
} finally {
  await browser.close();
  await server.close();
}
