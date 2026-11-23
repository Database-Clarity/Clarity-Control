import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { startRoleHarness } from './start.mjs';
import { localPath } from '../../apps/web/test/dev-role-web.mjs';
import { prepareSandbox } from './sandbox.mjs';

const browserPath = [
  process.env.PICKER_BROWSER,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!browserPath) throw new Error('Set PICKER_BROWSER to an installed Chromium browser.');

const socket = createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const { port } = socket.address();
await new Promise((done) => socket.close(done));
const app = await startRoleHarness({ port, prepareSandbox });
const git = (...args) =>
  execFileSync('git', ['--git-dir', app.dataGitDir, ...args], {
    encoding: 'utf8',
  }).trim();
const directory = app.origin + localPath;
let browser;

try {
  const liveRef = 'refs/heads/converter-v2-test';
  const liveBefore = git('rev-parse', liveRef);
  const bundleUrl =
    directory +
    '/upstream/raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json';
  const bundleResponse = await fetch(bundleUrl);
  assert.equal(bundleResponse.status, 200);
  const { tooltips, pushed, inactiveMoves } = await bundleResponse.json();
  const tooltip = process.argv[2]
    ? tooltips[process.argv[2]]
    : (tooltips[935202422] ??
      Object.values(tooltips).find(
        ({ hash, text, archive, custom }) =>
          hash > 3 &&
          pushed[hash] &&
          !inactiveMoves?.[hash] &&
          !archive &&
          !custom &&
          /^[\p{L}\s'’,.:-]{20,160}$/u.test(text.en?.text ?? ''),
      ));
  assert.ok(
    tooltip?.text.en?.text &&
      pushed[tooltip.hash] &&
      !inactiveMoves?.[tooltip.hash] &&
      !tooltip.archive,
    'Choose an active tooltip with published English text',
  );

  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--disable-background-networking'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const me = async (role, action) => {
    const expected = page.waitForResponse(
      (r) => r.url() === directory + '/api/me' && r.request().headers().authorization && r.ok(),
    );
    await action();
    const user = await (await expected).json();
    assert.equal(user.role, role);
    return user;
  };
  const translator = await me('translator', () =>
    page.goto(`${app.origin}/?dev-role=translator-de#/t/${tooltip.hash}?lang=de`, {
      waitUntil: 'domcontentloaded',
    }),
  );
  assert.deepEqual(translator.languages, ['de']);
  const editable = page
    .getByRole('region', { name: / editor \(German\)$/ })
    .locator('.cm-content[contenteditable="true"]:visible');
  await editable.waitFor();
  const german = tooltip.text.de?.text
    ? ' Lokaler Prüfsatz.'
    : tooltip.hash === 935202422
      ? 'Offene Visierung. Beim Zielen bleibt das periphere Sichtfeld erhalten.'
      : 'Deutscher Prüftext für den lokalen Test.';
  await editable.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(german);

  await page.locator('[data-drafts-button]').click();
  await page.locator('[data-drafts-review]').click();
  const review = page.getByRole('dialog', { name: 'Review save' });
  const save = page.waitForResponse(
    (r) => r.url() === directory + '/api/save' && r.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Save changes' }).click();
  const saved = await save;
  assert.equal(saved.status(), 200, await saved.text());
  const result = await saved.json();
  const current = result.tooltips.find(({ hash }) => hash === tooltip.hash);
  assert.ok(current?.text.de.text.includes(german.trim()));
  git('merge-base', '--is-ancestor', result.commit, 'refs/heads/editor-data');
  const stored = () => git('show', `refs/heads/editor-data:tooltips/${tooltip.hash}.json`);
  const afterSave = stored();
  assert.ok(JSON.parse(afterSave).text.de.text.includes(german.trim()));
  console.log(`PASS German save for ${tooltip.hash} at ${result.commit}`);

  const language = page.getByLabel('Language', { exact: true });
  await language.selectOption('en');
  await page
    .getByRole('region', { name: / editor \(English\)$/ })
    .locator('.cm-content[contenteditable="false"]:visible')
    .waitFor();
  // The UI is read-only. Send the same save shape directly to prove the Worker refuses it too.
  const english = structuredClone(current);
  english.text.en.text += ' Local test.';
  english.text.en.updatedAt = new Date().toISOString();
  english.text.en.updatedBy = translator.login;
  const denied = await context.request.post(directory + '/api/save', {
    headers: { authorization: saved.request().headers().authorization },
    data: {
      changes: [{ hash: tooltip.hash, base: current, next: english }],
      message: 'Local English refusal',
    },
  });
  assert.equal(denied.status(), 403, await denied.text());
  assert.match(await denied.text(), /assigned languages/);
  assert.equal(stored(), afterSave);
  console.log('PASS English editor was read-only and the Worker refused the forced save (403)');

  await me('editor', async () => {
    await page.getByRole('button', { name: 'Dev role', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Development identity' });
    await dialog.getByRole('combobox').selectOption('editor');
    await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  });
  await page.waitForFunction(
    async ({ url, hash, text }) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return false;
      const bundle = await response.json();
      return bundle.tooltips[hash]?.text.de?.text === text;
    },
    { url: bundleUrl, hash: tooltip.hash, text: current.text.de.text },
    { polling: 5000, timeout: 1_200_000 },
  );
  await page.goto(`${app.origin}/#/review?hash=${tooltip.hash}`);
  await page.getByRole('link', { name: 'Open in editor ↗' }).waitFor();
  assert.ok(
    (await page.getByRole('link', { name: 'Open in editor ↗' }).getAttribute('href')).endsWith(
      `/t/${tooltip.hash}`,
    ),
  );
  await page.getByRole('button', { name: /^Include/ }).click();
  await page.locator('[data-review-publish]').click();
  const publish = page.waitForResponse(
    (r) => r.url() === directory + '/api/publish' && r.request().method() === 'POST',
  );
  await page
    .getByRole('dialog', { name: 'Publish to live' })
    .getByRole('button', { name: 'Publish 1', exact: true })
    .click();
  const accepted = await publish;
  assert.equal(accepted.status(), 202, await accepted.text());
  const activity = page.getByRole('region', { name: 'Publish activity' });
  await activity.locator('li[data-status="done"]').waitFor({ timeout: 1_200_000 });
  const liveAfter = git('rev-parse', liveRef);
  assert.notEqual(liveAfter, liveBefore);
  console.log(
    `PASS Editor published ${tooltip.hash}. Disposable live ref ${liveBefore} → ${liveAfter}`,
  );
} finally {
  await browser?.close();
  await app.close();
}
