/* global document, window */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// The finder on real generator data: the exotic armour category lists armour pieces (not perks),
// a perk search resolves to its piece, and the perk's hash still opens. Screenshots go to argv[2];
// argv[3] is the generator's items.json.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/exotic-armour-shots');
const itemsPath = process.argv[3] ?? 'D:/GitHub/Description-data-generator/templates/v2/items.json';
await mkdir(shots, { recursive: true });
const all = JSON.parse(await readFile(itemsPath, 'utf8'));
const real = Object.fromEntries(
  Object.entries(all).filter(([, item]) => item.categoryId === 'armor-trait-exotic'),
);
const port = 5292;
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
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, phone] of [
      [390, 844, true],
      [1280, 800, false],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}#/t/8507332`);
      await page.locator('header').first().waitFor();
      await page.evaluate((items) => {
        window.shellFixture.role('maintainer');
        window.shellFixture.exoticArmour(items);
        window.location.hash = '#/t/8507332';
      }, real);
      const openList = async () => {
        if (phone) {
          await page.locator('header button[aria-haspopup="dialog"][aria-expanded]').nth(1).click();
          await page.getByRole('dialog', { name: 'Find' }).waitFor();
        } else {
          await page.getByRole('combobox', { name: 'Tooltip' }).click();
        }
        await page.locator('[role="listbox"] [role="option"]').first().waitFor();
      };
      const field = page.getByRole('combobox', { name: 'Tooltip' });
      await openList();
      assert.equal(await field.getAttribute('placeholder'), 'Contraverse Hold');
      // The list is windowed (only rows near the viewport are in the DOM), so walk it by
      // scrolling and record every row once, keyed by its aria-posinset.
      const all = await page.evaluate(async () => {
        const list = document.querySelector('[role="listbox"]');
        const frame = () => new Promise((done) => window.requestAnimationFrame(() => done()));
        const clips = (el) => Boolean(el) && el.scrollWidth > el.clientWidth + 1;
        // Each row is mark, icon (both aria-hidden), name, then the perk/hash line.
        const nameOf = (row) => row.querySelector(':scope > span:not([aria-hidden])');
        const seen = new Map();
        let setSize = 0;
        const collect = () => {
          for (const row of list.querySelectorAll('[role="option"]')) {
            setSize = Number(row.getAttribute('aria-setsize'));
            seen.set(Number(row.getAttribute('aria-posinset')), {
              text: row.textContent,
              title: row.getAttribute('title') ?? '',
              name: nameOf(row)?.textContent ?? '',
              cutName: clips(nameOf(row)),
              cutPerk: [...row.querySelectorAll('small > span:not(:last-child)')].some(clips),
              cutHash: clips(row.querySelector('small > span:last-child')),
            });
          }
        };
        list.scrollTop = 0;
        await frame();
        collect();
        while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
          list.scrollTop += Math.max(1, Math.floor(list.clientHeight / 2));
          await frame();
          await frame();
          collect();
        }
        list.scrollTop = 0;
        await frame();
        return { setSize, rows: [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) };
      });
      const texts = all.rows.map((row) => row.text);
      assert.equal(all.setSize, 138, `${theme} ${width}: one row per exotic perk (set size)`);
      assert.equal(texts.length, 138, `${theme} ${width}: one row per exotic perk`);
      assert.ok(texts.some((t) => t.includes('Contraverse Hold')));
      assert.ok(
        !texts.some((t) => t.startsWith('Chaotic Exchanger')),
        'perk name is not the label',
      );
      assert.ok(texts.some((t) => t.includes('Chaotic Exchanger · 8507332')));
      // Only the Aeon set's three perks, carried by three different pieces, are shared: the row
      // names the pieces (no extra mark) and keeps the perk legible on the right.
      const shared = all.rows
        .filter((row) => row.title.startsWith('Shared perk'))
        .map((r) => r.text);
      assert.equal(shared.length, 3, `${theme} ${width}: shared rows ${shared}`);
      assert.ok(shared.every((t) => t.startsWith('Aeon Safe/Soul/Swift')));
      assert.ok(shared.some((t) => t.includes('Sect of Force · 3268255645')));
      assert.ok(!texts.some((t) => t.includes('shared perk')));
      const names = all.rows.filter((row) => row.name.startsWith('Aeon')).map((r) => r.cutName);
      assert.equal(names.length, 3);
      assert.ok(!names.some(Boolean), `${theme} ${width}: Aeon piece names truncate`);
      // The hash stays whole. Name and perk each take what they need and share the row only
      // when both are long (13c12278, owner DESIGN QUALITY): a piece name may give way only on
      // a row whose perk gives way too.
      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflowX <= 0, `${theme} ${width}: horizontal overflow`);
      assert.deepEqual(
        all.rows.filter((row) => row.cutName && !row.cutPerk).map((row) => row.text),
        [],
        `${theme} ${width}: piece names truncate while the perk has room`,
      );
      assert.deepEqual(
        all.rows.filter((row) => row.cutHash).map((row) => row.text),
        [],
        `${theme} ${width}: hashes truncate`,
      );
      await page.screenshot({ path: `${shots}/${theme}-list-${width}.png` });
      // A perk search resolves to its piece; Enter opens the perk.
      await field.fill('chaotic exch');
      const found = await page
        .locator('[role="listbox"] [role="option"]')
        .evaluateAll((rows) => rows.map((row) => row.textContent));
      assert.equal(found.length, 1);
      assert.match(found[0], /Contraverse Hold/);
      await page.screenshot({ path: `${shots}/${theme}-search-perk-${width}.png` });
      await field.fill('aeon soul');
      await page.screenshot({ path: `${shots}/${theme}-search-aeon-${width}.png` });
      await field.fill('praxic vest');
      await page.keyboard.press('Enter');
      // The editor names the open item "Piece · Perk": window title, heading and (desktop) the
      // preview header, with the piece above the perk.
      await page.waitForFunction(
        () => document.title === 'Clarity Control — Praxic Vestment · Praxic Lift',
      );
      assert.equal(await page.locator('h1').first().textContent(), 'Praxic Vestment · Praxic Lift');
      if (phone) {
        // The phone header stacks the piece over the perk, both whole, instead of cutting the perk.
        const title = page.locator('header button[aria-haspopup="dialog"][aria-expanded]').nth(1);
        const lines = await title.evaluate((button) => {
          const text = button.querySelector('span');
          const kicker = text.querySelector('span');
          const clips = (el) => el.scrollWidth > el.clientWidth + 1;
          return {
            kicker: kicker?.textContent,
            name: text.lastChild?.textContent,
            clipped: clips(text) || (kicker && clips(kicker)),
            height: button.getBoundingClientRect().height,
          };
        });
        assert.equal(lines.kicker, 'Praxic Vestment');
        assert.equal(lines.name, 'Praxic Lift');
        assert.ok(!lines.clipped, 'phone title clipped');
        assert.ok(lines.height <= 48, `phone title grew the header: ${lines.height}`);
      } else {
        assert.match(
          await page.locator('section[aria-label$="preview"] header').first().innerText(),
          /Praxic Vestment\s+Praxic Lift/i,
        );
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${shots}/${theme}-opened-${width}.png` });
      await context.close();
    }
  }
  console.log('Exotic armour list passed.');
} finally {
  await browser.close();
  await server.close();
}
