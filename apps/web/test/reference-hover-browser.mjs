/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Starts its own Vite server; all data is synthetic. Screenshots go to argv[2].
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ?? resolve(web, '../../.agents/reports/hover-globals-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.REFERENCE_HOVER_PORT ?? 5237);
const url = `http://127.0.0.1:${port}/test/reference-hover.html`;
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
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 520 },
      colorScheme: scheme,
    });
    await page.goto(url);
    await page.locator('.cm-content').waitFor();
    const hover = async (text, name) => {
      const box = await page.evaluate((needle) => {
        const walker = document.createTreeWalker(
          document.querySelector('.cm-content'),
          globalThis.NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent.indexOf(needle);
          if (index >= 0) {
            const range = document.createRange();
            range.setStart(node, index + 1);
            range.setEnd(node, index + 2);
            const r = range.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, text);
      assert.ok(box, `${text} on screen`);
      await page.mouse.move(box.x + 40, box.y + 80);
      await page.mouse.move(box.x, box.y);
      await page.locator('.clarity-reference-popover').waitFor({ timeout: 3000 });
      await page.screenshot({ path: `${shots}/${name}-${scheme}.png` });
      return page.locator('.clarity-reference-popover').innerText();
    };
    const variable = await hover('#damage', 'variable');
    assert.match(variable, /25/);
    await page.mouse.move(5, 5);
    await page.locator('.clarity-reference-popover').waitFor({ state: 'detached' });
    const title = await hover('[Details]', 'title');
    assert.match(title, /Stacks up/);
    await page.mouse.move(5, 5);
    await page.locator('.clarity-reference-popover').waitFor({ state: 'detached' });
    const imported = await hover('Perk', 'import');
    assert.match(imported, /Deals/);
    await page.mouse.move(5, 5);
    await page.locator('.clarity-reference-popover').waitFor({ state: 'detached' });
    assert.match(await hover('#missing', 'missing'), /Not defined/);
    await page.mouse.move(5, 5);

    // Ctrl+Click and F12 navigate (global) or select (local) without editing the text.
    const before = await page.locator('.cm-content').innerText();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.evaluate(() => document.querySelector('.cm-content').focus());
    const damage = await page.locator('.cm-content').getByText('#damage').first().boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(damage.x + 10, damage.y + 8);
    await page.locator('.clarity-reference-link').waitFor({ timeout: 3000 });
    if (scheme === 'dark') await page.screenshot({ path: `${shots}/ctrl-underline-dark.png` });
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Control');
    assert.match(await page.locator('#navigated').innerText(), /"hash":2.*"line":1/);
    assert.equal(await page.locator('.cm-content').innerText(), before);
    await page.close();
  }
  console.log('reference hover browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
