/* global indexedDB, window */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { configBytes, inventory, sha256 } from './rehearse.mjs';

test('inventory pins proposed bytes, preserves URL case, and leaves all approvals pending', () => {
  const result = inventory('a'.repeat(40));
  assert.equal(result.projects.length, 7);
  for (const project of result.projects) {
    assert.equal(project.proposedConfigSha256, sha256(configBytes(project.config)));
    assert.equal(project.installedConfigSha256, null);
    assert.equal(project.config.files.length, 1);
    assert.equal(project.config.files[0].preset.toLowerCase(), project.config.id);
    assert.ok(
      project.oldUrls.every((url) => url.endsWith(`/${project.config.files[0].preset}.json`)),
    );
  }
  assert.ok(result.projects.some((p) => p.oldUrls[0].endsWith('/lightGG.json')));
  assert.ok(result.projects.some((p) => p.oldUrls[0].endsWith('/vaultZero.json')));
  assert.ok(Object.values(result.evidence).every((e) => e.status === 'PENDING'));
  assert.ok(Object.values(result.ownerApprovals).every((value) => value === null));
  assert.equal(result.candidateCommit, null);
  assert.throws(() => inventory('HEAD'));
});

// Opt in after building with the EXISTING test-only origin config; never uses hosted origins.
test(
  'isolated moved-page draft transfer',
  { skip: process.env.CUTOVER_MOVED_LOCAL !== '1' },
  async () => {
    const { preview } = await import('vite');
    const { chromium } = await import('playwright-core');
    const servers = [];
    let browser;
    const old = 'http://127.0.0.1:43171';
    const receiver = 'http://localhost:43172';
    try {
      for (const [mode, port] of [
        ['old', 43171],
        ['new', 43172],
      ]) {
        servers.push(
          await preview({
            root: 'apps/web',
            configFile: false,
            build: { outDir: `dist-migrate-${mode}` },
            preview: { host: '127.0.0.1', port, strictPort: true },
          }),
        );
      }
      const executablePath =
        process.env.CUTOVER_BROWSER ??
        [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        ].find(existsSync);
      browser = await chromium.launch({ executablePath, headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      // Fail closed: even an unexpected app fetch must never reach a hosted service.
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (![old, receiver].includes(url.origin)) return route.abort();
        if (url.pathname === '/seed')
          return route.fulfill({
            body: '<!doctype html><title>Seed</title>',
            contentType: 'text/html',
          });
        return route.continue();
      });
      const page = await context.newPage();
      const target = await context.newPage();
      const draft = (text) => {
        const tip = {
          hash: 1,
          text: { en: { text, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } },
          associated: [],
        };
        return { base: tip, next: tip };
      };
      async function storage(page, value) {
        return page.evaluate(
          (value) =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open('clarity-editor-v2', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('drafts');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction('drafts', value ? 'readwrite' : 'readonly');
                const store = tx.objectStore('drafts');
                let result;
                if (value) {
                  store.clear();
                  for (const [key, data] of Object.entries(value)) store.put(data, key);
                } else {
                  const read = store.getAll();
                  read.onsuccess = () => {
                    result = read.result;
                  };
                }
                tx.oncomplete = () => {
                  db.close();
                  resolve(result);
                };
                tx.onerror = () => {
                  db.close();
                  reject(tx.error);
                };
              };
            }),
          value,
        );
      }
      await page.goto(old + '/seed');
      const source = { tooltips: { 1: draft('source') }, 'tooltips:user:7': { broken: true } };
      await storage(page, source);
      await target.goto(receiver + '/seed');
      await page.goto(old);
      await page.getByText('Tooltip drafts, account 7', { exact: true }).waitFor();
      async function move() {
        const opened = page.waitForEvent('popup');
        await page.getByRole('button', { name: /Move my drafts|Try again/ }).click();
        const popup = await opened;
        await popup.getByRole('button', { name: 'Merge into this browser' }).waitFor();
        return popup;
      }
      let popup = await move();
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Move cancelled.' }).waitFor();
      assert.deepEqual(await storage(page), Object.values(source));
      assert.deepEqual(await storage(target), []);
      await popup.close();
      popup = await move();
      await popup.getByRole('button', { name: 'Merge into this browser' }).click();
      await page.getByRole('button', { name: 'Remove local copies…' }).waitFor();
      assert.deepEqual(await storage(target), [{ 1: draft('source') }]);
      await popup.close();
      await page.reload();
      popup = await move();
      await popup.getByRole('button', { name: 'Merge into this browser' }).click();
      await popup.getByRole('status').filter({ hasText: '0 new drafts, 1 already here' }).waitFor();
      assert.deepEqual(await storage(target), [{ 1: draft('source') }]);
      // Editing after transfer must keep the source draft on explicit clear.
      await storage(page, { ...source, tooltips: { 1: draft('edited') } });
      await page.getByRole('button', { name: 'Remove local copies…' }).click();
      await page.getByRole('button', { name: 'Keep them', exact: true }).click();
      await page.getByRole('button', { name: 'Remove local copies…' }).click();
      await page.getByRole('button', { name: 'Yes, remove moved drafts', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Removed 0 moved drafts' }).waitFor();
      assert.deepEqual(await storage(page), [{ 1: draft('edited') }, { broken: true }]);
      await popup.close();
      // A signed-out conflict cannot be parked: preserve both sides, and offer a download.
      await page.reload();
      popup = await move();
      await popup.getByRole('button', { name: 'Merge into this browser' }).click();
      await popup.getByRole('button', { name: 'Download unmerged drafts' }).waitFor();
      assert.deepEqual(await storage(target), [{ 1: draft('source') }]);
      await popup.close();
      await page.reload();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export to file' }).click();
      const file = await download;
      const bytes = await readFile(await file.path());
      assert.deepEqual(JSON.parse(bytes).buckets, { tooltips: { 1: draft('edited') } });
      await storage(target, {});
      await target.goto(receiver + '/#/migrate');
      await target
        .getByLabel('Import file')
        .setInputFiles({ name: 'drafts.json', mimeType: 'application/json', buffer: bytes });
      await target.getByRole('button', { name: 'Merge into this browser' }).click();
      await target.getByRole('status').filter({ hasText: '1 new draft' }).waitFor();
      assert.deepEqual(await storage(target), [{ 1: draft('edited') }]);
      // Correct opener window at a disallowed origin: receiver must ignore its real postMessage.
      const opened = target.waitForEvent('popup');
      await target.evaluate(() => {
        window.cutoverPopup = window.open('/#/migrate', '_blank');
      });
      const wrong = await opened;
      await wrong.getByRole('heading', { name: 'Move drafts to this editor' }).waitFor();
      await target.evaluate(
        (payload) =>
          window.cutoverPopup.postMessage(
            { channel: 'clarity-migrate', version: 1, type: 'snapshot', payload },
            window.location.origin,
          ),
        bytes.toString(),
      );
      await wrong.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 100)));
      assert.equal(await wrong.getByRole('button', { name: 'Merge into this browser' }).count(), 0);
      assert.deepEqual(await storage(target), [{ 1: draft('edited') }]);
      console.log(
        'PASS cancel, retry, partial unreadable, duplicate, conflict, edited clear, file fallback, and wrong origin.',
      );
    } finally {
      await browser?.close();
      await Promise.all(
        servers.map((server) => new Promise((resolve) => server.httpServer.close(resolve))),
      );
    }
  },
);
