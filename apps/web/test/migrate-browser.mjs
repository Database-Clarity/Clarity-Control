/* global document, indexedDB, window */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const evidence = await mkdtemp(join(tmpdir(), 'migrate-qa-'));
console.log('QA evidence:', evidence);
async function capture(page, state) {
  for (const width of [390, 768, 1280]) for (const theme of ['light', 'dark']) for (const scale of (width === 390 ? [100, 120, 150] : [100, 150])) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = `${16 * scale / 100}px`; }, { theme, scale });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${state} ${width} ${theme} ${scale}: horizontal overflow`);
    await page.screenshot({ path: join(evidence, `${state}-${width}-${theme}-${scale}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
}
const old = 'http://127.0.0.1:43171';
async function seed(page, broken = true) {
  await page.evaluate((broken) => new Promise((resolve, reject) => {
    const request = indexedDB.open('clarity-editor-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
      store.clear();
      const tip = { hash: 1, text: { en: { text: 'readable', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } }, associated: [] };
      store.put({ '1': { base: tip, next: tip } }, 'tooltips');
      if (broken) store.put({ broken: true }, 'tooltips:user:7');
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), broken);
}
async function move() {
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: /Move my drafts|Try again/ }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: 'Merge into this browser' }).waitFor();
  return popup;
}
try {
  await page.goto(old + '/seed'); await seed(page); await page.goto(old);
  await page.getByText('tooltips:user:7', { exact: true }).waitFor();
  await capture(page, 'partial');
  let popup = await move(); await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Cancelled on the new site.' }).waitFor();
  await capture(popup, 'cancelled');
  await popup.close(); await page.waitForTimeout(1200);
  assert.equal(await page.getByRole('alert').innerText(), 'Cancelled on the new site.');
  popup = await move();
  await popup.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('clarity-editor-v2', 1); r.onsuccess = () => { const db = r.result; const t = db.transaction('drafts', 'readwrite'); t.objectStore('drafts').put({ broken: true }, 'tooltips'); t.oncomplete = () => { db.close(); resolve(); }; }; }));
  await popup.getByRole('button', { name: 'Merge into this browser' }).click();
  await popup.getByRole('alert').filter({ hasText: 'merge stopped' }).waitFor();
  await capture(popup, 'refused');
  const refusal = await page.getByRole('alert').innerText();
  await seed(popup, false); await popup.close(); await page.waitForTimeout(1200);
  assert.equal(await page.getByRole('alert').innerText(), refusal);
  popup = await move(); await popup.close();
  await page.getByRole('alert').filter({ hasText: 'closed before the merge finished' }).waitFor();
  popup = await move(); await popup.getByRole('button', { name: 'Merge into this browser' }).click();
  await page.getByRole('button', { name: 'Remove moved drafts from here…' }).click();
  await capture(page, 'confirm');
  await page.getByRole('button', { name: 'Keep them', exact: true }).click();
  await page.getByRole('button', { name: 'Remove moved drafts from here…' }).click();
  await page.getByRole('button', { name: 'Yes, remove moved drafts', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Removed 1 moved draft' }).waitFor();
  await capture(page, 'removed');
  const remaining = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('clarity-editor-v2', 1); r.onsuccess = () => { const db = r.result; const t = db.transaction('drafts'); const q = t.objectStore('drafts').getAll(); q.onsuccess = () => { db.close(); resolve(q.result); }; };
  }));
  assert.deepEqual(remaining, [{}, { broken: true }]);
  await popup.close();
  console.log('PASS cross-origin open, handshake, cancel/close, premature close, merge, two-step clear, and unreadable preservation');
} finally { await browser.close(); }
