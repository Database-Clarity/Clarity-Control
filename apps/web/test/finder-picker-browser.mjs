/* global document, MouseEvent, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'finder-picker-'));
const evidence = process.env.PICKER_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const logs = [];
let browser;
try {
  await build({
    configFile: false,
    root: web,
    base: './',
    logLevel: 'error',
    build: {
      target: 'esnext',
      outDir: output,
      rollupOptions: { input: join(web, 'test/finder-picker-browser.html') },
    },
  });
  browser = await chromium.launch({
    executablePath:
      process.env.PICKER_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--allow-file-access-from-files'],
  });
  for (const width of [390, 768, 1280])
    for (const theme of ['dark', 'light'])
      for (const scale of [100, ...(width === 390 ? [120] : []), 150]) {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
        });
        await page.route('https://www.bungie.net/**', (route) =>
          route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="gray"/></svg>',
          }),
        );
        await page.goto(pathToFileURL(join(output, 'test/finder-picker-browser.html')).href);
        await page.getByRole('combobox', { name: 'Category', exact: true }).waitFor();
        await page.evaluate(
          ({ theme, scale }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
          },
          { theme, scale },
        );
        for (const label of ['Category', 'Group'])
          for (let opening = 0; opening < 2; opening++) {
            const frames = await page.evaluate(async (label) => {
              const trigger = document.querySelector(`button[aria-label="${label}"]`);
              trigger.focus();
              const frames = [];
              const result = new Promise((resolve) => {
                const sample = () => {
                  const list = document.querySelector('[role="listbox"]');
                  if (list) {
                    const row = list.querySelector('[aria-selected="true"]');
                    const rect = row.getBoundingClientRect();
                    const box = list.getBoundingClientRect();
                    frames.push({
                      scrollTop: list.scrollTop,
                      scrollHeight: list.scrollHeight,
                      clientHeight: list.clientHeight,
                      rowTop: rect.top - box.top,
                      rowBottom: rect.bottom - box.top,
                      active: trigger.getAttribute('aria-activedescendant'),
                    });
                    // Moving from the trigger into a partially clipped first row must not
                    // scroll that hovered row into view and push the selection offscreen.
                    if (frames.length === 1) {
                      const clipped = [...list.querySelectorAll('[role="option"]')].find(
                        (option) => {
                          const rect = option.getBoundingClientRect();
                          return rect.top < box.top && rect.bottom > box.top;
                        },
                      );
                      clipped?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                    }
                  }
                  if (frames.length < 10) requestAnimationFrame(sample);
                  else resolve(frames);
                };
                requestAnimationFrame(sample);
              });
              trigger.click();
              return result;
            }, label);
            const name = `${width}-${theme}-${scale}-${label}-${opening}`;
            logs.push({ name, frames });
            console.log(name, JSON.stringify(frames));
            if (!process.env.PICKER_BASELINE) {
              for (const frame of frames) {
                for (const key of [
                  'scrollTop',
                  'scrollHeight',
                  'clientHeight',
                  'rowTop',
                  'rowBottom',
                ])
                  assert.equal(frame[key], frames[0][key], `${name}: ${key} shifted after opening`);
                assert.ok(
                  frame.rowTop >= -1 && frame.rowBottom <= frame.clientHeight + 1,
                  `${name}: selection outside list`,
                );
              }
            }
            if (evidence && opening === 0)
              await page.screenshot({ path: join(evidence, `${name}.png`) });
            await page.keyboard.press('Escape');
          }
        await page.close();
      }
} finally {
  if (evidence) await writeFile(join(evidence, 'frames.json'), JSON.stringify(logs, null, 2));
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
