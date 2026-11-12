/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// "Load draft…" in the real shell on the local editor-drafts fixture: render matrix (390 / 768 /
// 1280, both themes, UI scale 100 and 150) and the state sweep (load, undo, discard, typed text,
// source changed, saved elsewhere, failed draft file, roles, requests while typing).
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/draft-loader-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.PORT ?? 5317);
const url = `http://127.0.0.1:${port}/test/draft-loader.html`;

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
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.right > window.innerWidth + 1 &&
          !el.closest('[hidden]') &&
          !el.closest('[aria-label="Markup tools"]') &&
          !el.closest('.cm-scroller') &&
          getComputedStyle(el).visibility !== 'hidden'
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
  }));
  assert.ok(overflow.page <= 0, `${label}: page scrolls horizontally by ${overflow.page}`);
  assert.deepEqual(overflow.wide, [], `${label}: elements run past the window`);
};
/** Header controls and the popover's controls: no clipped text, no wrapped labels. */
const clipped = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[role="group"][aria-label="Editor tools"] button, [role="dialog"] button, [role="dialog"] a',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible')
          return true;
        const style = getComputedStyle(el);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.25;
        return el.tagName === 'BUTTON' && r.height > Math.max(2 * line + 8, 50);
      })
      .map((el) => `${el.tagName} ${el.textContent.trim().slice(0, 30)}`),
  );

async function open(
  theme,
  width,
  height,
  { phone = false, scale = 100, role = 'maintainer', hash = '#/t/3000?lang=en' } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (scale > 100)
    await context.addInitScript((value) => {
      try {
        localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
      } catch {
        /* none */
      }
    }, scale);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate((who) => window.shellFixture.role(who), role);
  await page.evaluate((target) => (window.location.hash = target), hash);
  await page.locator('.cm-content').first().waitFor();
  return { context, page, errors };
}
const trigger = (page) => page.getByRole('button', { name: 'Load draft…' });
const editorText = (page) =>
  page
    .locator('.cm-content')
    .first()
    .evaluate((el) =>
      [...el.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
    );
const requests = (page) => page.evaluate(() => [...window.draftFixture.requests]);

try {
  // Render matrix.
  for (const theme of ['dark', 'light'])
    for (const [width, height, phone] of [
      [1280, 800, false],
      [768, 900, false],
      [390, 844, true],
    ])
      for (const scale of [100, 150]) {
        const label = `${theme} ${width} s${scale}`;
        const { context, page, errors } = await open(theme, width, height, { phone, scale });
        await trigger(page).waitFor({ timeout: 5000 });
        await page.screenshot({ path: `${shots}/${theme}-${width}-s${scale}-header.png` });
        await noOverflow(page, label);
        assert.deepEqual(await clipped(page), [], `${label}: header controls clip or wrap`);
        await trigger(page).click();
        const dialog = page.getByRole('dialog', { name: 'Draft for this tooltip' });
        await dialog.waitFor();
        await noOverflow(page, `${label} popover`);
        assert.deepEqual(await clipped(page), [], `${label}: popover controls clip or wrap`);
        const box = await dialog.boundingBox();
        assert.ok(
          box.x >= 0 && box.x + box.width <= width + 0.5,
          `${label}: popover inside the window`,
        );
        assert.ok((await dialog.textContent()).includes('Weapon Perks'), `${label}: source label`);
        await page.screenshot({ path: `${shots}/${theme}-${width}-s${scale}-popover.png` });
        assert.deepEqual(errors, [], `${label}: no page errors`);
        await context.close();
      }

  // State sweep (desktop, dark).
  {
    const { context, page, errors } = await open('dark', 1280, 800);
    await trigger(page).waitFor({ timeout: 5000 });
    assert.deepEqual(
      await requests(page),
      ['index.json', 'drafts/3000.json'],
      'one index, one draft',
    );
    // Load: the editor holds the draft as an unsaved edit; the control goes.
    await trigger(page).click();
    await page.getByRole('button', { name: 'Load draft', exact: true }).click();
    assert.match(await editorText(page), /^Final blows with this weapon/, 'loaded into the editor');
    assert.equal(await trigger(page).count(), 0, 'hidden once loaded');
    assert.equal(
      await page.getByRole('button', { name: "Discard this tooltip's draft" }).count(),
      1,
      'an unsaved draft (Discard offered)',
    );
    await page.screenshot({ path: `${shots}/flow-loaded.png` });
    // Undo: one step back to empty, and the offer returns.
    await page.keyboard.press('Control+z');
    assert.equal(await editorText(page), '', 'undo empties the editor');
    await trigger(page).waitFor({ timeout: 3000 });
    assert.equal(
      await page.getByRole('button', { name: "Discard this tooltip's draft" }).count(),
      0,
      'no draft after undo',
    );
    // Redo brings it back; Discard removes it.
    await page.keyboard.press('Control+y');
    assert.match(await editorText(page), /^Final blows/, 'redo restores the draft');
    await page.getByRole('button', { name: "Discard this tooltip's draft" }).click();
    await trigger(page).waitFor({ timeout: 3000 });
    assert.equal(await editorText(page), '', 'discard empties the editor');
    // Typed text hides it; deleting it again offers it again. No draft request while typing.
    const before = (await requests(page)).length;
    await page.locator('.cm-content').first().click();
    await page.keyboard.type('Typed');
    assert.equal(await trigger(page).count(), 0, 'hidden while the tooltip has text');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    await trigger(page).waitFor({ timeout: 3000 });
    assert.equal((await requests(page)).length, before, 'no requests while typing');
    // Source changed.
    await page.evaluate(() => window.draftFixture.sourceChanged());
    await trigger(page).click();
    await page.getByText('Source changed since this draft').waitFor();
    await page.screenshot({ path: `${shots}/flow-source-changed.png` });
    await page.keyboard.press('Escape');
    // Saved elsewhere: the tooltip has text now.
    await page.evaluate(() => window.draftFixture.savedElsewhere(3000));
    await page.waitForTimeout(300);
    assert.equal(await trigger(page).count(), 0, 'hidden once saved elsewhere');
    // A listed draft whose file fails, and a written tooltip: nothing.
    for (const hash of ['#/t/3001?lang=en', '#/t/1000?lang=en']) {
      await page.evaluate((target) => (window.location.hash = target), hash);
      await page.waitForTimeout(1200);
      assert.equal(await trigger(page).count(), 0, `${hash}: nothing offered`);
    }
    const all = await requests(page);
    assert.equal(all.filter((path) => path === 'index.json').length, 1, 'index once per session');
    assert.deepEqual(errors, [], 'flow: no page errors');
    await context.close();
  }

  // Roles: trial editors and translators never see it; editors do.
  for (const [role, shown] of [
    ['editor', true],
    ['trial', false],
    ['translator', false],
  ]) {
    const { context, page } = await open('dark', 1280, 800, { role });
    await page.waitForTimeout(2000);
    assert.equal(
      (await trigger(page).count()) > 0,
      shown,
      `${role}: ${shown ? 'shown' : 'hidden'}`,
    );
    if (!shown)
      assert.equal(
        (await requests(page)).filter((p) => p.startsWith('drafts/')).length,
        0,
        `${role}: no draft request`,
      );
    await context.close();
  }
  console.log('draft-loader browser: PASS');
} finally {
  await browser.close();
  await server.close();
}
