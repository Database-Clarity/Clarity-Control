/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// UI-FIXES-2B in the real shell on synthetic data, both themes at 390 / 768 / 1280 and UI scale
// 100 / 150: compact notices (content-sized, stacked, never full width, Esc dismisses, the editor
// text never moves), the phone header title and the narrow-header mark, and the status-bar Suggest
// button. Writes screenshots into argv[2]; `--report` prints the measurements without asserting.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const report = args.includes('--report');
const shots =
  args.find((arg) => !arg.startsWith('--')) ??
  resolve(web, '../../.agents/reports/ui-fixes-2b-shots');
await mkdir(shots, { recursive: true });
const port = Number(process.env.QA_PORT ?? 5311);
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

const problems = [];
const check = (condition, message) => {
  if (condition) return;
  if (report) problems.push(message);
  else assert.fail(message);
};

async function open(
  theme,
  width,
  height,
  { phone, scale, hash = '#/t/1000?lang=en', drafts = true },
) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
  });
  if (scale > 100) {
    await context.addInitScript((value) => {
      try {
        localStorage.setItem('clarity-settings:device:v1', JSON.stringify({ uiScale: value }));
      } catch {
        /* none */
      }
    }, scale);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate((withDrafts) => {
    window.shellFixture.role('maintainer');
    window.shellFixture.variants();
    if (withDrafts) window.shellFixture.drafts(3);
  }, drafts);
  await page.evaluate((target) => {
    window.location.hash = target;
  }, hash);
  await page.locator('header').first().waitFor();
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const noOverflow = async (page, label) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label}: page scrolls horizontally by ${wide}`);
};
const editorTop = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('.cm-line');
    const rect = line?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), left: Math.round(rect.left) } : null;
  });

const sizes = [
  { width: 390, height: 844, phone: true },
  { width: 768, height: 900, phone: false },
  { width: 1280, height: 800, phone: false },
];
const only = process.env.QA_ONLY?.split(',');

try {
  for (const theme of ['dark', 'light']) {
    for (const scale of [100, 150]) {
      for (const { width, height, phone } of sizes) {
        const label = `${theme} ${width} s${scale}`;
        const name = `${theme}-${width}-s${scale}`;
        if (only && !only.some((part) => label.includes(part))) continue;
        const log = (...parts) => report && console.log(label, ...parts);

        // ---- Header: brand, tabs, no clipped labels ----
        {
          const { context, page, errors } = await open(theme, width, height, { phone, scale });
          const header = await page.evaluate(() => {
            const head = document.querySelector('header');
            const rect = head.getBoundingClientRect();
            const brand = head.querySelector(
              '[aria-label="Clarity Control"], img[alt="Clarity Control"]',
            );
            const visible = (el) => !!el && el.getBoundingClientRect().width > 0;
            const images = [...head.querySelectorAll('img')].filter(visible).map((img) => ({
              alt: img.alt,
              w: Math.round(img.getBoundingClientRect().width),
              h: Math.round(img.getBoundingClientRect().height),
            }));
            const clipped = [...head.querySelectorAll('a, button, h1, span')]
              .filter((el) => {
                const style = getComputedStyle(el);
                return (
                  el.getBoundingClientRect().width > 0 &&
                  el.scrollWidth > el.clientWidth + 1 &&
                  (style.overflow !== 'visible' || style.textOverflow === 'ellipsis') &&
                  el.textContent.trim().length > 0 &&
                  !el.closest('[hidden]')
                );
              })
              .map((el) => el.textContent.trim().slice(0, 30));
            return {
              height: Math.round(rect.height),
              brand: brand ? brand.tagName : null,
              images,
              clipped,
              finder: Math.round(
                head.querySelector('[role="combobox"]')?.getBoundingClientRect().width ?? 0,
              ),
              title: Math.round(
                head.querySelector('h1, [data-tooltip-finder]')?.getBoundingClientRect().width ?? 0,
              ),
              scrollW: document.documentElement.scrollWidth,
            };
          });
          log('header', JSON.stringify(header));
          if (phone) {
            const tabs = await page.evaluate(() =>
              [...document.querySelectorAll('[role="tab"]')]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => ({
                  text: el.textContent.trim(),
                  cut: el.scrollWidth > el.clientWidth + 1,
                })),
            );
            log('phone tabs', JSON.stringify(tabs));
            check(
              tabs.length > 0 && tabs.every((t) => !t.cut),
              `${label}: a phone tab is truncated ${JSON.stringify(tabs)}`,
            );
          }
          check(header.clipped.length === 0, `${label}: clipped header text ${header.clipped}`);
          await noOverflow(page, `${label} header`);
          await page.screenshot({
            path: `${shots}/${name}-header-editor.png`,
            clip: { x: 0, y: 0, width, height: 130 },
          });
          check(errors.length === 0, `${label}: page errors ${errors}`);
          await context.close();
        }

        // ---- Header on the Compendium page (phone: the title is the page name) ----
        {
          const { context, page } = await open(theme, width, height, {
            phone,
            scale,
            hash: '#/compendium',
          });
          const facts = await page.evaluate(() => {
            const head = document.querySelector('header');
            const labels = [...head.querySelectorAll('a, button, h1')]
              .filter(
                (el) => el.getBoundingClientRect().width > 0 && /Compendium/.test(el.textContent),
              )
              .map((el) => {
                const inner = el.querySelector('span') ?? el;
                return {
                  tag: el.tagName,
                  text: el.textContent.trim(),
                  scrollW: inner.scrollWidth,
                  clientW: inner.clientWidth,
                  ellipsis: getComputedStyle(inner).textOverflow,
                };
              });
            return labels;
          });
          log('compendium label', JSON.stringify(facts));
          check(
            facts.every((f) => f.scrollW <= f.clientW + 1),
            `${label}: Compendium label truncated ${JSON.stringify(facts)}`,
          );
          await noOverflow(page, `${label} compendium`);
          await page.screenshot({
            path: `${shots}/${name}-header-compendium.png`,
            clip: { x: 0, y: 0, width, height: 130 },
          });
          await context.close();
        }

        // ---- Notices ----
        {
          const { context, page } = await open(theme, width, height, { phone, scale });
          const before = await editorTop(page);
          await page.evaluate(() => window.shellFixture.notice('all'));
          await page.locator('[data-notice-strip]').waitFor();
          check(
            JSON.stringify(await editorTop(page)) === JSON.stringify(before),
            `${label}: a notice moved the editor text`,
          );
          const facts = await page.evaluate(() => {
            const notices = [...document.querySelectorAll('[data-notice-strip] > [data-level]')];
            return notices.map((el) => {
              const r = el.getBoundingClientRect();
              const close = el
                .querySelector('button[aria-label="Dismiss"]')
                ?.getBoundingClientRect();
              const text = el.querySelector('span')?.getBoundingClientRect();
              return {
                level: el.dataset.level,
                w: Math.round(r.width),
                h: Math.round(r.height),
                right: Math.round(window.innerWidth - r.right),
                // Gap between the end of the message (or last action) and the close button.
                gap: close && text ? Math.round(close.left - text.right) : null,
              };
            });
          });
          log('notices', JSON.stringify(facts));
          for (const notice of facts) {
            check(
              notice.w < width - 40 || width <= 420,
              `${label}: ${notice.level} notice spans the window (${notice.w}px)`,
            );
          }
          // The stack sits at the bottom-right: it must not cover any control of the page behind it.
          const covered = await page.evaluate(() => {
            const rects = [...document.querySelectorAll('[data-notice-strip] > [data-level]')].map(
              (el) => el.getBoundingClientRect(),
            );
            return [...document.querySelectorAll('button, a[href], input, select, [role="tab"]')]
              .filter((el) => !el.closest('[data-notice-strip]') && !el.closest('[hidden]') && true)
              .filter((el) => {
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) return false;
                return rects.some(
                  (n) =>
                    r.left < n.right && r.right > n.left && r.top < n.bottom && r.bottom > n.top,
                );
              })
              .map((el) =>
                (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30),
              );
          });
          log('covered by notices', JSON.stringify(covered));
          // Desktop: the stack must stay clear of every control. A phone is as short as three stacked
          // notices, so there it covers some of the page while they show (they answer or dismiss).
          check(
            phone || covered.length === 0,
            `${label}: notices cover controls ${JSON.stringify(covered)}`,
          );
          await noOverflow(page, `${label} notices`);
          await page.screenshot({
            path: `${shots}/${name}-notices.png`,
            clip: { x: 0, y: 0, width, height },
          });
          await page.evaluate(() => window.shellFixture.notice('long'));
          await page.screenshot({
            path: `${shots}/${name}-notice-long.png`,
            clip: { x: 0, y: 0, width, height },
          });
          await context.close();
        }

        // ---- Preview term popovers: top layer, inside the viewport, never covered or clipped ----
        // (the column starts collapsed in the compact layout, below 1100px effective width)
        if (!phone && (width * 100) / scale >= 1100) {
          const { context, page } = await open(theme, width, height, {
            phone,
            scale,
            drafts: false,
          });
          await page.evaluate(() => window.shellFixture.titles());
          const anchors = page.locator(
            'section[aria-label$="preview"] [tabindex="0"][aria-describedby]',
          );
          await anchors.first().waitFor({ state: 'attached' });
          const count = await anchors.count();
          check(count >= 3, `${label}: preview has ${count} term anchors`);
          for (let i = 0; i < count; i++) {
            const anchor = anchors.nth(i);
            await anchor.scrollIntoViewIfNeeded();
            await anchor.hover();
            const facts = await page.evaluate((index) => {
              const el = document.querySelectorAll(
                'section[aria-label$="preview"] [tabindex="0"][aria-describedby]',
              )[index];
              const box = el.querySelector('[role="tooltip"]');
              const r = box.getBoundingClientRect();
              const centre = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + Math.min(r.height / 2, 20),
              );
              return {
                open: box.matches(':popover-open'),
                left: Math.round(r.left),
                top: Math.round(r.top),
                right: Math.round(r.right),
                bottom: Math.round(r.bottom),
                covered: !box.contains(centre),
                scrollsX: box.scrollWidth > box.clientWidth + 1,
                vw: document.documentElement.clientWidth,
                vh: document.documentElement.clientHeight,
              };
            }, i);
            log('popover', i, JSON.stringify(facts));
            check(facts.open, `${label}: popover ${i} is not in the top layer`);
            check(
              facts.left >= 0 &&
                facts.right <= facts.vw &&
                facts.top >= 0 &&
                facts.bottom <= facts.vh,
              `${label}: popover ${i} leaves the viewport ${JSON.stringify(facts)}`,
            );
            check(!facts.covered, `${label}: popover ${i} is covered by another element`);
            check(!facts.scrollsX, `${label}: popover ${i} does not wrap its text`);
            await page.screenshot({ path: `${shots}/${name}-popover-${i}.png` });
            await page.mouse.move(width - 2, height - 2);
            const closed = await page.evaluate((index) => {
              const anchors = document.querySelectorAll(
                'section[aria-label$="preview"] [tabindex="0"][aria-describedby]',
              );
              return !anchors[index].querySelector('[role="tooltip"]').matches(':popover-open');
            }, i);
            check(closed, `${label}: popover ${i} stays open after the pointer leaves`);
          }
          await context.close();
        }

        // ---- Status bar Suggest (touch only) ----
        if (phone) {
          const { context, page } = await open(theme, width, height, { phone, scale });
          const measureBar = () =>
            page.evaluate(() => {
              const bar = document.querySelector('[data-editor-status]');
              const rect = bar.getBoundingClientRect();
              const buttons = [...bar.querySelectorAll('button')]
                .filter((b) => b.getBoundingClientRect().width > 0)
                .map((b) => {
                  const r = b.getBoundingClientRect();
                  const range = document.createRange();
                  range.selectNodeContents(b);
                  const tops = [...range.getClientRects()].map((t) => t.top);
                  return {
                    text: b.textContent.trim(),
                    left: Math.round(r.left),
                    right: Math.round(r.right),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    scrollW: b.scrollWidth,
                    clientW: b.clientWidth,
                    lines: tops.length ? (Math.max(...tops) - Math.min(...tops) > 6 ? 2 : 1) : 1,
                  };
                });
              return { bar: { w: Math.round(rect.width), scrollW: bar.scrollWidth }, buttons };
            });
          let facts = await measureBar();
          log('status', JSON.stringify(facts));
          const suggest = facts.buttons.find((b) => b.text === 'Suggest');
          check(!!suggest, `${label}: Suggest button missing`);
          if (suggest) {
            check(
              suggest.right <= width + 0.5 && suggest.left >= 0,
              `${label}: Suggest outside the window ${JSON.stringify(suggest)}`,
            );
            check(suggest.lines === 1, `${label}: Suggest wraps`);
            check(suggest.scrollW <= suggest.clientW + 1, `${label}: Suggest text clipped`);
          }
          check(
            facts.bar.scrollW <= facts.bar.w + 1,
            `${label}: status bar overflows ${JSON.stringify(facts.bar)}`,
          );
          for (const button of facts.buttons)
            check(button.right <= width + 0.5, `${label}: ${button.text} runs past the window`);
          await page.screenshot({
            path: `${shots}/${name}-status.png`,
            clip: { x: 0, y: Math.max(0, height - 140), width, height: 140 },
          });
          // Worst case: a character warning and a markup issue join the bar.
          await page.locator('.cm-content:visible').first().click();
          await page.keyboard.press('Control+End');
          await page.keyboard.insertText(' 🠚 <yellow x');
          await page.waitForTimeout(700);
          facts = await measureBar();
          log('status worst', JSON.stringify(facts));
          const worst = facts.buttons.find((b) => b.text === 'Suggest');
          check(
            !!worst && worst.right <= width + 0.5,
            `${label}: Suggest pushed out with every item showing ${JSON.stringify(facts)}`,
          );
          check(
            facts.bar.scrollW <= facts.bar.w + 1,
            `${label}: status bar overflows with every item showing ${JSON.stringify(facts.bar)}`,
          );
          for (const button of facts.buttons)
            check(button.lines === 1, `${label}: ${button.text} wraps with every item showing`);
          await page.screenshot({
            path: `${shots}/${name}-status-worst.png`,
            clip: { x: 0, y: Math.max(0, height - 140), width, height: 140 },
          });
          await context.close();
        }
      }
    }
  }
  if (report) console.log(problems.length ? `PROBLEMS\n${problems.join('\n')}` : 'no problems');
  else console.log('shell fixes browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
