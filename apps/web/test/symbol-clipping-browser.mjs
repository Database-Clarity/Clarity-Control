/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// UI-FIXES-2B item 15: the inline symbols (damage types, ammo, breakers, classes) must show their
// whole artwork. For every symbol in the preview column, the editor's symbol widgets and the markup
// row, in both themes at UI scale 100 and 150, the drawn artwork (its opaque bounds inside the
// scaled background) has to sit inside the ::before box, and the box advance must stay 16px (1rem)
// so text never shifts. Zoomed screenshots go to argv[2]; `--report` prints instead of asserting.
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const report = args.includes('--report');
const shots =
  args.find((arg) => !arg.startsWith('--')) ??
  resolve(web, '../../.agents/reports/ui-fixes-2b-shots/symbols');
await mkdir(shots, { recursive: true });
const port = Number(process.env.QA_PORT ?? 5471);
const url = `http://127.0.0.1:${port}/test/shell.html`;
const cache = process.env.QA_CACHE ?? resolve(shots, '.images');
await mkdir(cache, { recursive: true });

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

const names = [
  'kinetic',
  'arc',
  'solar',
  'void',
  'stasis',
  'strand',
  'primary',
  'special',
  'heavy',
  'barrier',
  'overload',
  'unstoppable',
  'hunter',
  'titan',
  'warlock',
];
const problems = [];
const check = (condition, message) => {
  if (condition) return;
  if (report) problems.push(message);
  else assert.fail(message);
};

// Opaque bounds (fractions of the image) for every artwork URL a symbol draws.
const bounds = new Map();
async function artBounds(urls) {
  const missing = urls.filter((u) => !bounds.has(u));
  if (!missing.length) return;
  const items = {};
  for (const u of missing) {
    // Small SVGs are inlined by the bundler as data: URLs; the browser decodes those itself.
    if (u.startsWith('data:')) {
      items[u] = { src: u };
      continue;
    }
    let buf;
    if (u.startsWith('http')) {
      const file = resolve(cache, u.split('/').pop());
      if (!existsSync(file))
        await writeFile(file, Buffer.from(await (await fetch(u)).arrayBuffer()));
      buf = await readFile(file);
    } else {
      const response = await fetch(u);
      buf = Buffer.from(await response.arrayBuffer());
    }
    const type = /\.svg(\?|$)/.test(u) ? 'image/svg+xml' : 'image/png';
    if (type === 'image/png' && buf.subarray(1, 4).toString() !== 'PNG')
      throw new Error(`${u} is not a PNG: ${buf.subarray(0, 60).toString()}`);
    items[u] = { src: `data:${type};base64,${buf.toString('base64')}` };
  }
  const page = await browser.newPage();
  const result = await page.evaluate(async (list) => {
    const out = {};
    for (const [u, { src }] of Object.entries(list)) {
      const img = new window.Image();
      img.src = src;
      await img.decode();
      const w = 160;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = w;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, w);
      const d = ctx.getImageData(0, 0, w, w).data;
      let l = w,
        t = w,
        r = -1,
        b = -1;
      for (let j = 0; j < w; j++)
        for (let i = 0; i < w; i++)
          if (d[(j * w + i) * 4 + 3] > 24) {
            l = Math.min(l, i);
            r = Math.max(r, i);
            t = Math.min(t, j);
            b = Math.max(b, j);
          }
      out[u] = { l: l / w, t: t / w, r: (r + 1) / w, b: (b + 1) / w };
    }
    return out;
  }, items);
  await page.close();
  for (const [u, v] of Object.entries(result)) bounds.set(u, v);
}

async function open(theme, scale) {
  const context = await browser.newContext({
    // At 150% the layout behaves like a window a third narrower: widen it so the preview column
    // (collapsed in the compact layout) stays open.
    viewport: { width: Math.round((1280 * scale) / 100), height: 900 },
    colorScheme: theme,
    deviceScaleFactor: 3,
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
  await page.goto(url);
  await page.locator('header').first().waitFor();
  await page.evaluate(() => {
    window.shellFixture.role('maintainer');
    window.shellFixture.variants();
  });
  await page.evaluate(() => {
    window.location.hash = '#/t/1000?lang=en';
  });
  await page.locator('.cm-content').first().waitFor();
  await page.waitForTimeout(500);
  return { context, page };
}

/** Geometry of every symbol ::before under `selector` (a root or the elements themselves). */
const geometry = (page, where, list) =>
  page.evaluate(
    ({ where: scope, list: wanted }) => {
      const out = [];
      for (const name of wanted) {
        const match = (el) =>
          [...el.classList].some(
            (c) => c === name || c.endsWith(`_${name}`) || c.includes(`_${name}_`),
          );
        const roots = [...document.querySelectorAll(scope)];
        const els = roots.flatMap((root) => [root, ...root.querySelectorAll('*')]).filter(match);
        const visible = els.filter(
          (el) => el.getBoundingClientRect().width > 0 && !el.closest('[hidden]'),
        );
        const el = visible[0];
        if (!el) {
          out.push({ name, missing: true });
          continue;
        }
        const style = getComputedStyle(el, '::before');
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const zoom = Number(getComputedStyle(el).zoom) || 1;
        const px = (v) => parseFloat(v);
        // Light draws the artwork's alpha as a mask over a token fill; dark as the background image.
        const masked = style.maskImage && style.maskImage !== 'none';
        const sizeText = masked ? style.maskSize : style.backgroundSize;
        const size = sizeText.split(' ').map(px);
        const image = /url\("?([^")]+)"?\)/.exec(masked ? style.maskImage : style.backgroundImage)?.[1];
        out.push({
          name,
          image,
          boxW: px(style.width),
          boxH: px(style.height),
          marginL: px(style.marginLeft),
          marginR: px(style.marginRight),
          bgW: size[0],
          // `auto` height keeps the (square) artwork's aspect.
          bgH: Number.isFinite(size[1]) ? size[1] : size[0],
          contain: sizeText === 'contain',
          rem,
          zoom,
        });
      }
      return out;
    },
    { where, list },
  );

async function verify(label, facts, { inline = true } = {}) {
  const urls = facts.filter((f) => f.image).map((f) => new URL(f.image, url).href);
  await artBounds(urls);
  const rows = [];
  for (const f of facts) {
    if (f.missing) {
      rows.push(`${label} ${f.name}: not rendered`);
      continue;
    }
    const b = bounds.get(new URL(f.image, url).href);
    // `contain` fits the whole square image in the box; otherwise the background is bgW x bgH
    // centred in the box.
    const bgW = f.contain ? Math.min(f.boxW, f.boxH) : f.bgW;
    const bgH = f.contain ? Math.min(f.boxW, f.boxH) : f.bgH;
    const left = (f.boxW - bgW) / 2 + b.l * bgW;
    const right = (f.boxW - bgW) / 2 + b.r * bgW;
    const top = (f.boxH - bgH) / 2 + b.t * bgH;
    const bottom = (f.boxH - bgH) / 2 + b.b * bgH;
    const out = Math.max(-left, right - f.boxW, -top, bottom - f.boxH, 0);
    const advance = f.boxW + f.marginL + f.marginR;
    rows.push(
      `${label} ${f.name}: box ${f.boxW.toFixed(1)}x${f.boxH.toFixed(1)} advance ${advance.toFixed(1)} art ${left.toFixed(1)}..${right.toFixed(1)} x ${top.toFixed(1)}..${bottom.toFixed(1)} cropped ${out.toFixed(2)}px`,
    );
    check(
      out < 0.25,
      `${label} ${f.name}: artwork cropped by ${out.toFixed(2)}px (${left.toFixed(2)}..${right.toFixed(2)} in a ${f.boxW.toFixed(1)}px box)`,
    );
    check(
      !inline || Math.abs(advance - f.rem) < 0.6,
      `${label} ${f.name}: advance ${advance.toFixed(2)}px, want ${f.rem}px (text would shift)`,
    );
  }
  if (report) console.log(rows.join('\n'));
}

try {
  for (const theme of ['dark', 'light']) {
    for (const scale of [100, 150]) {
      const label = `${theme} s${scale}`;
      const { context, page } = await open(theme, scale);

      // Preview column (the finder fixture's text carries every symbol).
      const preview = 'section[aria-label$="preview"]';
      await verify(`${label} preview`, await geometry(page, preview, names));
      await page
        .locator(`${preview}:visible`)
        .first()
        .screenshot({ path: `${shots}/${theme}-s${scale}-preview.png` });

      // Editor symbol widgets.
      await verify(`${label} editor`, await geometry(page, '.cm-content', names));
      const lines = page.locator('.cm-content:visible');
      await lines.first().screenshot({ path: `${shots}/${theme}-s${scale}-editor.png` });

      // Markup row (open by default).
      const row = page.locator('[data-markup-row]');
      await row.waitFor();
      // Row buttons centre the glyph box (no inline margins), so only the cropping applies.
      await verify(`${label} row`, await geometry(page, '[data-markup-row]', names), {
        inline: false,
      });
      await row.screenshot({ path: `${shots}/${theme}-s${scale}-row.png` });
      await context.close();
    }
  }
  if (report) console.log(problems.length ? `PROBLEMS\n${problems.join('\n')}` : 'no problems');
  else console.log('symbol clipping checks passed');
} finally {
  await browser.close();
  await server.close();
}
