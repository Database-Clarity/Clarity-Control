/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Overhaul P2 step 9 (+ tinted colour tags) in the real shell on synthetic data: icon tags drawn as
// fixed-width symbols, colour tags hidden with their text tinted in the preview's tag colour, the
// hover/selection popover, the raw toggle (Ctrl+Shift+.) and the caret-reveal setting.
// Both themes at 390 / 768 / 1280 (+ the smallest and largest interface scale once): zero horizontal
// overflow, one width for every symbol, AA contrast for every tint, and hover/popover never move text.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/tint-tags-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.SYMBOLS_BROWSER_PORT ?? 5299);
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

const lineTops = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')].map((line) => {
      const box = line.getBoundingClientRect();
      return [Math.round(box.top * 10) / 10, Math.round(box.height * 10) / 10];
    }),
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

// Tags do not nest (the converter closes a tag at its first />), so icons and other tags sit beside
// them, not inside.
const sample =
  '<yellow 10% /> <arc/> <pve 5 /> <pvp [3] /> <blue reload /> <bold nested /> <green lone\n<kinetic/><arc/><solar/><void/><stasis/><strand/><heavy/><primary/><special/><barrier/><overload/><unstoppable/> icons\n<purple void /> <arc/> <bold b /> <yellow y /> <green g /> <pve 7 /> <pvp [9] />\n';
const tinted = ['yellow', 'blue', 'green', 'purple', 'pve', 'pvp'];
// WCAG contrast between a tint colour and the editor surface.
const contrastOf = (page) =>
  page.evaluate((names) => {
    const channels = (css) =>
      css
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const luminance = ([r, g, b]) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const surface = luminance(
      channels(getComputedStyle(document.querySelector('.cm-editor')).backgroundColor),
    );
    return names.map((name) => {
      const el = document.querySelector(`.cm-tint-${name}`);
      const fg = luminance(channels(getComputedStyle(el).color));
      const [hi, lo] = fg > surface ? [fg, surface] : [surface, fg];
      return [name, Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100];
    });
  }, tinted);
async function open(theme, viewport, phone, scale) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (scale)
    await context.addInitScript((value) => {
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
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText(sample);
  await page.locator('.cm-symbol-icon').first().waitFor();
  await page.locator('.cm-tint').first().waitFor();
  return { context, page, errors };
}

async function check(theme, width, height, phone, scale, name) {
  const label = `${theme} ${width}${scale ? ` @${scale}%` : ''}`;
  const { context, page, errors } = await open(theme, { width, height }, phone, scale);
  const widgets = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-symbol')].map((el) => ({
      width: Math.round(el.getBoundingClientRect().width * 10) / 10,
      kind: el.className,
      markup: el.dataset.symbol,
    })),
  );
  assert.ok(widgets.length >= 13, `${label}: symbols drawn (${widgets.length})`);
  assert.ok(
    widgets.every((widget) => Math.abs(widget.width - widgets[0].width) <= 0.5),
    `${label}: one width for every symbol ${JSON.stringify([...new Set(widgets.map((w) => w.width))])}`,
  );
  const rem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  assert.ok(
    Math.abs(widgets[0].width - rem) <= 0.5,
    `${label}: symbol box is 1rem (${widgets[0].width} vs ${rem})`,
  );
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-symbol-icon')].map((el) => {
      // Light draws the artwork's alpha as a mask over a token fill; dark draws the artwork.
      const style = getComputedStyle(el, '::before');
      return style.backgroundImage !== 'none' || style.maskImage !== 'none';
    }),
  );
  assert.ok(drawn.length > 0 && drawn.every(Boolean), `${label}: icons draw the preview artwork`);
  assert.equal(
    await page.evaluate(() => document.querySelector('.cm-content').textContent.includes('<arc/>')),
    false,
    `${label}: raw tag text is not shown`,
  );
  // Colour tags: the markup is hidden, the enclosed text is tinted in the preview's own colour, AA on
  // the editor surface; an unpaired tag stays raw.
  const shown = await page.evaluate(() => document.querySelector('.cm-content').textContent);
  for (const raw of ['<yellow', '<pve', '<pvp', '<blue', '<bold', '<purple', ' />'])
    assert.ok(!shown.includes(raw), `${label}: ${raw} is hidden`);
  assert.ok(shown.includes('<green lone'), `${label}: an unpaired tag stays raw`);
  const tints = await page.evaluate((names) => {
    const probe = document.createElement('i');
    document.body.append(probe);
    const out = names.map((tintName) => {
      probe.style.color = `var(--tag-${tintName})`;
      return [
        tintName,
        getComputedStyle(document.querySelector(`.cm-tint-${tintName}`)).color,
        getComputedStyle(probe).color,
      ];
    });
    probe.remove();
    return out;
  }, tinted);
  for (const [tintName, drawnColour, tokenColour] of tints)
    assert.equal(drawnColour, tokenColour, `${label}: ${tintName} tint is the preview colour`);
  for (const [tintName, ratio] of await contrastOf(page))
    assert.ok(ratio >= 4.5, `${label}: ${tintName} tint contrast ${ratio} on the editor surface`);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.cm-tint-bold')).fontWeight),
    '700',
    `${label}: bold is bold`,
  );
  // Tags do not nest, as in the preview: no tint sits inside another.
  const nested = await page.evaluate(() => document.querySelectorAll('.cm-tint .cm-tint').length);
  assert.equal(nested, 0, `${label}: tints never nest`);
  await noOverflow(page, `${label} widgets`);
  await page.screenshot({ path: `${shots}/${name}-widgets.png` });

  const insideScroller = (page) =>
    page.evaluate(() => {
      const pop = document.querySelector('.cm-symbol-popover').getBoundingClientRect();
      const scroller = document.querySelector('.cm-scroller').getBoundingClientRect();
      return pop.top >= scroller.top - 0.5 && pop.bottom <= scroller.bottom + 0.5;
    });
  const before = await lineTops(page);
  if (!phone) {
    // Hover: a popover with the markup, no line moves.
    await page.locator('.cm-symbol').nth(2).hover();
    await page.locator('.cm-symbol-popover').waitFor();
    assert.ok(await insideScroller(page), `${label}: line-1 popover stays inside the editor`);
    assert.ok(
      (await page.locator('.cm-symbol-popover code').textContent()).startsWith('<'),
      `${label}: hover popover shows the markup`,
    );
    assert.deepEqual(await lineTops(page), before, `${label}: hover moved text`);
    await page.screenshot({ path: `${shots}/${name}-hover.png` });
    await page.mouse.move(2, 2);
    await page.locator('.cm-symbol-popover').waitFor({ state: 'detached' });
  }

  if (!phone) {
    // Tinted text on line 1: hover shows `<pve … />`, Alt+click pins it (Enter edits, Esc cancels).
    await page.locator('.cm-tint-pve').first().hover();
    await page.locator('.cm-symbol-popover').waitFor();
    assert.equal(
      (await page.locator('.cm-symbol-popover code').textContent()).trim(),
      '<pve … />',
      `${label}: tint hover popover`,
    );
    assert.ok(await insideScroller(page), `${label}: line-1 tint popover stays inside the editor`);
    assert.deepEqual(await lineTops(page), before, `${label}: tint hover moved text`);
    await page.screenshot({ path: `${shots}/${name}-tint-hover.png` });
    await page.mouse.move(2, 2);
    await page.locator('.cm-symbol-popover').waitFor({ state: 'detached' });
    await page
      .locator('.cm-tint-pve')
      .first()
      .click({ modifiers: ['Alt'] });
    await page.locator('.cm-symbol-hint').waitFor();
    assert.ok(await insideScroller(page), `${label}: pinned tint popover stays inside the editor`);
    await page.keyboard.press('Enter');
    await page.locator('.cm-symbol-input').waitFor();
    assert.deepEqual(await lineTops(page), before, `${label}: the tint edit popover moved text`);
    await page.screenshot({ path: `${shots}/${name}-tint-edit.png` });
    await page.keyboard.press('Escape');
    await page.locator('.cm-symbol-input').waitFor({ state: 'detached' });
    await page.locator('.cm-content').click({ position: { x: 4, y: 4 } });
  }

  // Click selects the symbol: popover with the hint, Enter edits, Esc cancels. Nothing moves.
  await page.locator('.cm-symbol').nth(1).click();
  await page.locator('.cm-symbol-popover').waitFor();
  assert.ok(await insideScroller(page), `${label}: pinned line-1 popover stays inside the editor`);
  assert.deepEqual(await lineTops(page), before, `${label}: selecting a symbol moved text`);
  await page.keyboard.press('Enter');
  await page.locator('.cm-symbol-input').waitFor();
  assert.deepEqual(await lineTops(page), before, `${label}: the edit popover moved text`);
  await page.screenshot({ path: `${shots}/${name}-edit.png` });
  await page.keyboard.press('Escape');
  await page.locator('.cm-symbol-input').waitFor({ state: 'detached' });
  assert.equal(
    await page.locator('.cm-symbol').count(),
    widgets.length,
    `${label}: Esc keeps the symbols`,
  );

  // Raw toggle: the markup shows, toggling back restores the exact layout.
  await page.locator('.cm-content').click({ position: { x: 4, y: 4 } });
  // The markup row carries the toggle on every screen: a pressed-state button naming the shortcut.
  const rawButton = page.locator('[data-markup-row] [data-raw-toggle]');
  assert.equal(await rawButton.isVisible(), true, `${label}: raw button is in the markup row`);
  assert.equal(await rawButton.getAttribute('aria-pressed'), 'false', `${label}: raw is off`);
  assert.ok(
    (await rawButton.getAttribute('title')).includes('Ctrl+Shift+.'),
    `${label}: raw button tooltip names the shortcut`,
  );
  await rawButton.click();
  assert.equal(await rawButton.getAttribute('aria-pressed'), 'true', `${label}: raw state shown`);
  assert.equal(await page.locator('.cm-symbol').count(), 0, `${label}: button shows raw`);
  await rawButton.click();
  assert.equal(
    await page.locator('.cm-symbol').count(),
    widgets.length,
    `${label}: button toggles back`,
  );
  await page.keyboard.press('Control+Shift+.');
  assert.equal(
    await rawButton.getAttribute('aria-pressed'),
    'true',
    `${label}: the button follows the shortcut`,
  );
  assert.equal(await page.locator('.cm-symbol').count(), 0, `${label}: raw view has no widgets`);
  assert.equal(await page.locator('.cm-tint').count(), 0, `${label}: raw view has no tints`);
  assert.ok(
    await page.evaluate(() => document.querySelector('.cm-content').textContent.includes('<arc/>')),
    `${label}: raw view shows the markup`,
  );
  await noOverflow(page, `${label} raw`);
  await page.screenshot({ path: `${shots}/${name}-raw.png` });
  await page.keyboard.press('Control+Shift+.');
  assert.equal(
    await page.locator('.cm-symbol').count(),
    widgets.length,
    `${label}: back to symbols`,
  );
  // Compared relative to line 1: tapping the status-bar button may scroll the page, which is not a reflow.
  const relative = (tops) =>
    tops.map(([top, height]) => [Math.round((top - tops[0][0]) * 10) / 10, height]);
  assert.deepEqual(
    relative(await lineTops(page)),
    relative(before),
    `${label}: toggling back changed the layout`,
  );

  assert.deepEqual(errors, [], `${label}: page errors`);
  await context.close();
}

try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ]) {
      await check(theme, width, height, phone, 0, `${theme}-${width}`);
    }
    await check(theme, 1280, 800, false, 85, `${theme}-1280-scale85`);
    await check(theme, 1280, 800, false, 150, `${theme}-1280-scale150`);
  }

  // Caret reveal (device setting): the raw tag shows only where the caret is.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ symbolReveal: 'caret' }));
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('header').first().waitFor();
    await page.evaluate(() => {
      window.shellFixture.role('maintainer');
      window.shellFixture.variants();
      window.shellFixture.kinetic();
      window.location.hash = '#/t/1000?lang=en';
    });
    await page.locator('.cm-content').first().waitFor();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('<arc/> <solar/> text\n');
    await page.locator('.cm-symbol').first().waitFor();
    const total = await page.locator('.cm-symbol').count();
    await page.locator('.cm-symbol').first().click();
    assert.ok(
      (await page.locator('.cm-symbol').count()) < total,
      'caret mode reveals the symbol under the caret',
    );
    assert.equal(await page.locator('.cm-symbol-popover').count(), 0, 'caret mode has no popover');
    await page.screenshot({ path: `${shots}/caret-reveal.png` });
    // A caret inside a colour tag reveals that tag's markup (its text stays tinted); others stay hidden.
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('<pve 5 /> and <pvp [3] />\n');
    await page.locator('.cm-tint-pve').first().waitFor();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Home');
    await page.locator('.cm-tint-pvp').first().click();
    const revealed = await page.locator('.cm-content').textContent();
    assert.ok(revealed.includes('<pvp [3]'), 'caret in a tag reveals its markup');
    assert.ok(!revealed.includes('<pve'), 'other tags stay hidden');
    assert.ok(
      (await page.locator('.cm-tint-pvp').count()) >= 1,
      'the tag stays tinted while its markup is revealed',
    );
    await page.screenshot({ path: `${shots}/caret-reveal-tint.png` });
    await context.close();
  }
  console.log('symbols browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
