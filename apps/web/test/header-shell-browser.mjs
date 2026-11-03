/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Header, role tabs, finder, drafts, identity and sheets of the real shell on synthetic data, in
// both themes. Asserts geometry that must hold (36px bar, 44px phone targets, no page overflow,
// editor text never shifting when an overlay opens) and writes screenshots to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/overhaul-s3-shots');
await mkdir(shots, { recursive: true });
const port = 5289;
const url = `http://127.0.0.1:${port}/test/header-shell.html`;

// A login service that is never called (the fixture sets the auth state itself), so the
// shell shows its signed-in states.
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

const setup = (page, calls) =>
  page.evaluate((list) => {
    for (const [name, ...args] of list) window.shellFixture[name](...args);
  }, calls);
const editorTop = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('.cm-line');
    const rect = line?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), left: Math.round(rect.left) } : null;
  });
const noOverflow = async (page, label) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    `${label}: page scrolls horizontally`,
  );

async function open(theme, viewport, { phone = false } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('header').first().waitFor();
  return { context, page };
}

try {
  for (const theme of ['dark', 'light']) {
    const out = (name) => `${shots}/${theme}-${name}.png`;

    // Five roles, header only, at 1440.
    {
      const { context, page } = await open(theme, { width: 1440, height: 760 });
      await page.locator('.cm-content').waitFor();
      for (const role of ['maintainer', 'editor', 'trial', 'translator', 'out', 'none']) {
        await setup(page, [
          ['role', role],
          ['drafts', role === 'maintainer' ? 3 : 0],
        ]);
        const bar = await page.locator('header').first().boundingBox();
        assert.equal(
          Math.round(bar.height),
          37,
          `${role}: header is 36px + 1px line (${bar.height})`,
        );
        await page.screenshot({
          path: out(`header-${role}`),
          clip: { x: 0, y: 0, width: 1440, height: 56 },
        });
      }
      // Loading and error identity states.
      for (const state of ['loading', 'error']) {
        await setup(page, [['role', state]]);
        await page.screenshot({
          path: out(`header-${state}`),
          clip: { x: 0, y: 0, width: 1440, height: 56 },
        });
      }
      await context.close();
    }

    // The editor at the widths the design names.
    for (const width of [1440, 1366, 1280, 1099]) {
      const { context, page } = await open(theme, { width, height: 760 });
      await page.locator('.cm-content').waitFor();
      await setup(page, [
        ['role', 'maintainer'],
        ['drafts', 3],
      ]);
      const bar = await page.locator('header > div').first().boundingBox();
      assert.equal(Math.round(bar.height), 36, `${width}: bar is 36px`);
      if (width < 1100) {
        const band = await page.locator('header > div').nth(1).boundingBox();
        assert.equal(Math.round(band.height), 32, 'compact finder band is 32px');
      }
      const tabs = await page.locator('nav[aria-label="Workspaces"] > ul > li').allInnerTexts();
      if (width <= 1280)
        assert.ok(!tabs.includes('Translations'), `${width}: Translations folds into More`);
      else
        assert.ok(
          tabs.some((text) => text.startsWith('Translations')),
          `${width}: Translations is a tab`,
        );
      await noOverflow(page, `editor ${width}`);
      await page.screenshot({ path: out(`editor-${width}`) });
      await context.close();
    }

    // Desktop interactions at 1280.
    {
      const { context, page } = await open(theme, { width: 1280, height: 760 });
      await page.locator('.cm-content').waitFor();
      await setup(page, [
        ['role', 'maintainer'],
        ['drafts', 4],
      ]);
      const before = await editorTop(page);

      // Finder: open, filter, highlight vs selected.
      const combobox = page.getByRole('combobox', { name: 'Tooltip' });
      await combobox.click();
      await page.getByRole('listbox').waitFor();
      await page.keyboard.press('ArrowDown');
      await page.screenshot({
        path: out('finder-open'),
        clip: { x: 0, y: 0, width: 1280, height: 420 },
      });
      await page.keyboard.type('long');
      await page.screenshot({
        path: out('finder-filtered'),
        clip: { x: 0, y: 0, width: 1280, height: 200 },
      });
      await page.keyboard.press('Escape');
      assert.equal(await combobox.inputValue(), 'Hammerhead', 'Escape restores the current item');
      assert.equal(await page.getByRole('listbox').count(), 0);
      await combobox.fill('zzzz');
      await page.screenshot({
        path: out('finder-empty'),
        clip: { x: 0, y: 0, width: 1280, height: 200 },
      });
      await page.keyboard.press('Escape');

      // Tabs: More menu.
      await page.getByRole('button', { name: /^More/ }).click();
      await page.screenshot({
        path: out('more-menu'),
        clip: { x: 0, y: 0, width: 1280, height: 260 },
      });
      await page.keyboard.press('Escape');

      // Drafts popover, including a recovered conflict, and the no-shift rule.
      await page.locator('[data-drafts-button]').click();
      await page.getByRole('dialog', { name: 'Drafts' }).waitFor();
      assert.deepEqual(await editorTop(page), before, 'opening drafts never moves the editor text');
      await page.screenshot({
        path: out('drafts-popover'),
        clip: { x: 0, y: 0, width: 1280, height: 520 },
      });
      await page.keyboard.press('Escape');
      await setup(page, [['recovered']]);
      await page.locator('[data-drafts-button]').click();
      await page.getByRole('dialog', { name: 'Drafts' }).waitFor();
      await page.screenshot({
        path: out('drafts-recovered'),
        clip: { x: 0, y: 0, width: 1280, height: 620 },
      });
      await page.keyboard.press('Escape');

      // Identity menu and the Settings transition (focus returns to the stable header button).
      await setup(page, [['role', 'translator']]);
      const beforeMenu = await editorTop(page);
      await page.locator('[data-identity-button]').click();
      await page.getByRole('dialog', { name: 'Account' }).waitFor();
      assert.deepEqual(
        await editorTop(page),
        beforeMenu,
        'opening the account menu never moves the editor text',
      );
      await page.screenshot({
        path: out('identity-menu'),
        clip: { x: 0, y: 0, width: 1280, height: 320 },
      });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog', { name: /settings/i }).waitFor();
      await page.screenshot({ path: out('settings-from-identity') });
      await page.getByRole('button', { name: 'Close settings' }).click();
      assert.equal(
        await page.evaluate(() => document.activeElement?.hasAttribute('data-identity-button')),
        true,
        'focus is back on the identity button',
      );
      await setup(page, [['dataError']]);
      await page.locator('[data-identity-button]').click();
      await page.screenshot({
        path: out('identity-data-error'),
        clip: { x: 0, y: 0, width: 1280, height: 360 },
      });
      await page.keyboard.press('Escape');

      // Compendium error shows "!" on the tab with an accessible name.
      await setup(page, [['role', 'maintainer'], ['compendiumError']]);
      assert.equal(await page.getByRole('img', { name: 'Compendium unavailable' }).count(), 1);
      await context.close();
    }

    // Phone: header, sheets, targets.
    {
      const { context, page } = await open(theme, { width: 390, height: 844 }, { phone: true });
      await page.locator('.cm-content').waitFor();
      await setup(page, [
        ['role', 'maintainer'],
        ['drafts', 3],
      ]);
      const header = await page.locator('header').first().boundingBox();
      assert.ok(
        header.height >= 48 && header.height <= 49,
        `phone header is 48px (${header.height})`,
      );
      for (const button of await page.locator('header button').all()) {
        const box = await button.boundingBox();
        if (!box) continue;
        assert.ok(
          box.height >= 44 && box.width >= 44,
          `phone header target ${box.width}x${box.height}`,
        );
      }
      await noOverflow(page, 'phone editor');
      const before = await editorTop(page);
      await page.screenshot({ path: out('phone-editor') });

      await page.getByRole('button', { name: 'Workspaces' }).click();
      await page.getByRole('dialog', { name: 'Workspaces' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.getElementById('shell-root').hasAttribute('inert')),
        true,
      );
      await page.screenshot({ path: out('phone-workspaces-sheet') });
      for (const row of await page.locator('nav[aria-label="Workspaces"] a').all()) {
        assert.ok((await row.boundingBox()).height >= 44, 'workspace rows are 44px');
      }
      await page.keyboard.press('Escape');

      await page.locator('header button[aria-haspopup="dialog"][aria-expanded]').nth(1).click();
      await page.getByRole('dialog', { name: 'Find' }).waitFor();
      await page.getByRole('combobox', { name: 'Tooltip' }).click();
      await page.screenshot({ path: out('phone-finder-sheet') });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await page.locator('[data-drafts-button]').click();
      await page.getByRole('dialog', { name: 'Drafts' }).waitFor();
      await page.screenshot({ path: out('phone-drafts-sheet') });
      await page.keyboard.press('Escape');
      assert.deepEqual(await editorTop(page), before, 'editor text did not move behind the sheets');

      await page.locator('[data-identity-button]').click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog', { name: /settings/i }).waitFor();
      await page.screenshot({ path: out('phone-settings-sheet') });
      await context.close();
    }
  }
  console.log('Header, tabs, finder, drafts, identity, sheets and screenshots passed.');
} finally {
  await browser.close();
  await server.close();
}
