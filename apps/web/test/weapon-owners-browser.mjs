/* global window, document, location */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startHarnessServer } from './harness-server.mjs';

const out = resolve(process.argv[2] ?? '.agents/weapon-owners-qa');
await mkdir(out, { recursive: true });
const all = JSON.parse(await readFile(process.argv[3], 'utf8'));
const shared = all[2620589274];
const single = all[281315705];
const orphan = {
  ...single,
  hash: 123,
  name: 'Ownerless fixture',
  owners: [],
  itemHash: undefined,
  itemName: undefined,
};
const real = { [shared.hash]: shared, [single.hash]: single, 123: orphan };
const server = await startHarnessServer(resolve('apps/web'), 5367);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const results = [];
try {
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1280])
      for (const scale of width === 390 ? [100, 120, 150] : [100, 150]) {
        const context = await browser.newContext({
          viewport: { width, height: 950 },
          colorScheme: theme,
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        await context.addInitScript(
          (scale) =>
            localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: scale })),
          scale,
        );
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:5367/test/shell.html#/t/1000');
        await page.waitForFunction(() => Boolean(window.shellFixture));
        await page.evaluate((real) => {
          window.shellFixture.exoticArmour(real);
          window.location.hash = '#/t/2620589274';
        }, real);
        await page.locator('.cm-content').first().waitFor();
        if (width === 390) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
        else {
          const show = page.getByRole('button', { name: /Show preview column/ });
          if (await show.count()) await show.first().click();
        }
        const header = page
          .locator('section[aria-label="The Fundamentals preview"] header')
          .first();
        await header.waitFor();
        await page.waitForFunction(() =>
          document
            .querySelector('section[aria-label="The Fundamentals preview"] header')
            ?.textContent.includes('Shared perk · Dead Messenger, Hard Light'),
        );
        assert.equal(await header.locator('img').count(), 3);
        const sharedHeight = (await header.boundingBox()).height;
        assert.ok(
          (await header.locator('img').first().getAttribute('src')) ===
            `https://www.bungie.net${shared.icon}`,
        );
        assert.ok(
          await header.locator('[title="Shared perk · Dead Messenger, Hard Light"]').count(),
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(overflow <= 0, `${theme}/${width}/${scale}: page overflow ${overflow}`);
        await page.screenshot({ path: `${out}/${theme}-${width}-${scale}-shared.png` });
        for (const [hash, name, icons, label] of [
          [single.hash, single.name, 2, 'Whisper of the Worm'],
          [123, orphan.name, 1, ''],
        ]) {
          await page.evaluate((hash) => (window.location.hash = `#/t/${hash}`), hash);
          const next = page.locator(`section[aria-label="${name} preview"] header`).first();
          await next.waitFor();
          assert.equal(await next.locator('img').count(), icons);
          assert.ok(
            Math.abs((await next.boundingBox()).height - sharedHeight) < 0.1,
            'exotic header height stays fixed (subpixel rounding only)',
          );
          assert.ok((await next.textContent()).includes(label));
          assert.ok(!(await next.textContent()).includes('Shared perk'));
        }
        await page.goBack();
        await page.locator(`section[aria-label="${single.name} preview"] header`).first().waitFor();
        await page.goBack();
        await header.waitFor();
        assert.equal(await header.locator('img').count(), 3);
        await page.goForward();
        await page.locator(`section[aria-label="${single.name} preview"] header`).first().waitFor();
        if (width === 1280 && scale === 100) {
          const field = page.getByRole('combobox', { name: 'Tooltip', exact: true });
          await page.getByRole('combobox', { name: 'Weapon', exact: true }).click();
          await page.locator('[role="option"][data-value="all"]').click();
          await field.click();
          await field.fill('no matching exotic fixture');
          await page.keyboard.press('Escape');
          assert.ok(
            (
              await page
                .locator(`section[aria-label="${single.name} preview"] header`)
                .first()
                .textContent()
            ).includes('Whisper of the Worm'),
          );
          await field.click();
          await field.fill('The Fundamentals');
          await page.keyboard.press('Enter');
          await header.waitFor();
          assert.equal(
            await header.locator('img').count(),
            3,
            'finder selection updates the header',
          );
          await field.click();
          await field.fill('White Nail');
          await page.keyboard.press('Enter');
          await field.evaluate((el) => el.blur());
          for (const alt of [false, true]) {
            const before = page.url();
            await field.hover();
            if (alt) await page.keyboard.down('Alt');
            await page.keyboard.down('Shift');
            await page.mouse.wheel(0, -120);
            await page.keyboard.up('Shift');
            if (alt) await page.keyboard.up('Alt');
            await page.waitForFunction((before) => location.href !== before, before);
            await page.waitForFunction(() => !document.querySelector('article[aria-busy]'));
            const hash = Number(page.url().match(/#\/t\/(\d+)/)[1]);
            const current = real[hash];
            assert.ok(current, `stepping visited fixture ${hash}`);
            const currentHeader = page
              .locator(`section[aria-label="${current.name} preview"] header`)
              .first();
            await currentHeader.waitFor();
            const ownerCount = hash === shared.hash ? 2 : hash === single.hash ? 1 : 0;
            assert.equal(
              await currentHeader.locator('img').count(),
              ownerCount + 1,
              'stepped header owner icons',
            );
          }
        }
        results.push({ theme, width, scale, sharedHeight, overflow, backForward: 'PASS' });
        await context.close();
      }
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `PASS ${results.length} render states, single/shared/ownerless headers, and Back/Forward`,
  );
} finally {
  await browser.close();
  await server.close();
}
