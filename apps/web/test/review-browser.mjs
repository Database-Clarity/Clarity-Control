/* global document, window, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.PICKER_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!browserPath) throw new Error('Set PICKER_BROWSER to an installed Chromium browser.');
const output = await mkdtemp(join(tmpdir(), 'clarity-review-regression-'));
const evidence = process.env.REVIEW_BROWSER_OUTPUT;
if (evidence) await mkdir(evidence, { recursive: true });
const results = [];
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
      emptyOutDir: false,
      rollupOptions: { input: join(web, 'test', 'browse-scroll.html') },
    },
  });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking'],
  });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 390, height: 500 },
  ]) {
    for (const variant of [
      'editor&long=true',
      'compendium',
      'compendium-linked-empty',
      'compendium-linked-populated',
      'review&keyboard=true',
      'compendium-sample',
      'compendium-entry',
      'compendium-entry&initial=entries',
      'compendium-entry&observer=none',
    ]) {
      const context = await browser.newContext({ viewport });
      const network = [];
      await context.route(/^https?:/, async (route) => {
        network.push(route.request().url());
        await route.abort();
      });
      if (variant.includes('observer=none'))
        await context.addInitScript(() => {
          window.ResizeObserver = undefined;
        });
      else if (variant.startsWith('compendium-entry'))
        await context.addInitScript(() => {
          const Original = window.ResizeObserver;
          const records = [];
          window.reviewObserverRecords = records;
          window.ResizeObserver = class {
            constructor(callback) {
              this.native = new Original(callback);
              this.record = { targets: [], disconnected: false, notify: () => callback([], this) };
              records.push(this.record);
            }
            observe(target, options) {
              this.record.targets.push(target);
              this.native.observe(target, options);
            }
            unobserve(target) {
              this.native.unobserve(target);
            }
            disconnect() {
              this.record.disconnected = true;
              this.native.disconnect();
            }
          };
        });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `${pathToFileURL(join(output, 'test', 'browse-scroll.html')).href}?workspace=${variant}`,
      );
      if (variant.includes('keyboard=true')) {
        await page.waitForFunction(
          () =>
            document.querySelector('[data-keyboard-ready]') ||
            document.querySelector('#result')?.textContent?.startsWith('FAIL'),
        );
        if (await page.locator('[data-keyboard-ready]').count()) await page.keyboard.press('Enter');
      }
      await page.waitForFunction(() =>
        /^(PASS|FAIL)/.test(document.querySelector('#result')?.textContent ?? ''),
      );
      const result = await page.locator('#result').textContent();
      assert.ok(result.startsWith('PASS '), `${variant} ${JSON.stringify(viewport)}: ${result}`);
      const measurements = JSON.parse(result.slice(5));
      let lifecycle;
      if (variant.startsWith('compendium-entry') && !variant.includes('observer=none')) {
        lifecycle = await page.evaluate(() => {
          const footer = document.querySelector('footer[aria-label="Review actions"]');
          const article = footer.closest('article');
          const before = article.style.getPropertyValue('--review-action-bar-height');
          const old = window.reviewObserverRecords.filter((record) =>
            record.targets.some(
              (target) =>
                target.matches('footer[aria-label="Review actions"]') && !target.isConnected,
            ),
          );
          old.forEach((record) => record.notify());
          return {
            oldTargets: old.length,
            disconnected: old.every((record) => record.disconnected),
            before,
            after: article.style.getPropertyValue('--review-action-bar-height'),
            actualHeight: footer.getBoundingClientRect().height,
          };
        });
        assert.ok(lifecycle.oldTargets >= 1, 'No actual detached footer callback tested');
        assert.ok(lifecycle.disconnected, 'Old footer observer remains connected');
        assert.equal(
          lifecycle.after,
          lifecycle.before,
          'Delayed callback overwrote new reservation',
        );
        assert.ok(
          Math.abs(Number.parseFloat(lifecycle.after) - lifecycle.actualHeight) < 1,
          'Stale reservation does not match actual footer',
        );
      }
      const name = `${variant.replaceAll('&', '-').replaceAll('=', '-')}-${viewport.width}x${viewport.height}`;
      if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
      const resizes = [];
      if (variant.startsWith('compendium-entry') && viewport.width === 1440) {
        const footer = await page.locator('footer[aria-label="Review actions"]').elementHandle();
        for (const resized of [
          { width: 390, height: 500 },
          { width: 390, height: 844 },
          viewport,
        ]) {
          await page.setViewportSize(resized);
          for (const overlayName of ['Bulk accept preview', 'Pick another source']) {
            if (overlayName === 'Pick another source') {
              await page.getByRole('button', { name: 'Cancel', exact: true }).click();
              await page.getByRole('button', { name: /^Pick other/ }).click();
            }
            await page.waitForFunction(() => {
              const footer = document.querySelector('footer[aria-label="Review actions"]');
              const reserved = Number.parseFloat(
                getComputedStyle(footer.closest('article')).getPropertyValue(
                  '--review-action-bar-height',
                ),
              );
              return Math.abs(reserved - footer.getBoundingClientRect().height) < 1;
            });
            const resize = await page
              .getByRole('dialog', { name: overlayName })
              .evaluate(async (overlay) => {
                for (const node of [...overlay.querySelectorAll('*')].reverse().concat(overlay))
                  if (/auto|scroll/.test(getComputedStyle(node).overflowY))
                    node.scrollTop = node.scrollHeight;
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                const footer = document.querySelector('footer[aria-label="Review actions"]');
                const buttons = overlay.querySelectorAll('button');
                const control = buttons[buttons.length - 1];
                const rect = (node) => {
                  const { x, y, width, height, bottom } = node.getBoundingClientRect();
                  return { x, y, width, height, bottom };
                };
                const bounds = rect(control);
                const hit = document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                );
                return {
                  overlay: rect(overlay),
                  footer: rect(footer),
                  finalControl: bounds,
                  unobscured: hit === control || control.contains(hit),
                };
              });
            assert.ok(
              resize.overlay.bottom <= resize.footer.y + 1,
              'Resized overlay overlaps footer',
            );
            assert.ok(
              resize.finalControl.y >= 0 && resize.finalControl.bottom <= resized.height,
              'Resized final control unreachable',
            );
            assert.ok(resize.unobscured, 'Resized final control obscured');
            assert.equal(
              await footer.evaluate(
                (node) => node === document.querySelector('footer[aria-label="Review actions"]'),
              ),
              true,
              'Resize remounted footer',
            );
            resizes.push({ viewport: resized, overlayName, ...resize });
            if (overlayName === 'Pick another source') {
              await page.getByRole('button', { name: 'Close picker', exact: true }).click();
              await page.getByRole('button', { name: 'Bulk preview (6)', exact: true }).click();
            }
          }
        }
      }
      assert.deepEqual(network, [], 'External network attempted');
      assert.deepEqual(errors, [], 'Uncaught browser errors');
      let unmount;
      if (variant.startsWith('compendium-entry')) {
        const article = await page
          .locator('footer[aria-label="Review actions"]')
          .evaluateHandle((node) => node.closest('article'));
        await page.evaluate(() => window.dispatchEvent(new Event('review-fixture-unmount')));
        unmount = await article.evaluate((article) => {
          const records = (window.reviewObserverRecords ?? []).filter((record) =>
            record.targets.some((target) => target.matches('footer[aria-label="Review actions"]')),
          );
          records.forEach((record) => record.notify());
          window.dispatchEvent(new Event('resize'));
          return {
            detached: !article.isConnected,
            disconnected: records.every((record) => record.disconnected),
            reservation: article.style.getPropertyValue('--review-action-bar-height'),
          };
        });
        assert.ok(
          unmount.detached && unmount.disconnected,
          'Full unmount left footer resources active',
        );
        assert.equal(unmount.reservation, '', 'Full unmount left or rewrote a reservation');
      }
      results.push({ variant, viewport, measurements, lifecycle, resizes, unmount });
      console.log(`${name}: PASS`);
      await context.close();
    }
  }
  if (evidence)
    await writeFile(join(evidence, 'green-geometry.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
