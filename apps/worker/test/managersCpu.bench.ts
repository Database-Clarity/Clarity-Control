// CPU of the translation manager routes (GET/POST/DELETE /translators/:lang, GET/POST
// /rollback/upload) in Node: a local proxy for the Workers FREE plan's 10 ms CPU limit, by the
// sandbox-pointers method. Not part of the suite:
//   npx vitest run --config <a config including this file>   (MANAGERS_CPU_OUT=<json> optional)
// The fixture GitHub mock resolves at once; its own time is measured and subtracted, so a
// request's remaining wall time is its CPU time (performance.now(): process.cpuUsage moves in
// ~15.6 ms steps on Windows). Cold = the first request of each case; warm = the next 10.
// Inputs: the largest real English texts (core's numbers fixture, from editor-data), every one
// of the 13 languages filled at that size (6 for 100 tooltips, see below), so each stored tooltip is a worst-case file; uploads
// of 1, 15, and 100 tooltips (the /save cap), with the /save that made each upload for scale.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { languages, type Permissions, type Tooltip } from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { Fixture, makePrivateKey } from './fixture.js';

const english: { english: { hash: number; text: string }[] } = JSON.parse(
  gunzipSync(readFileSync('packages/core/src/numbers/fixtures/english.json.gz')).toString('utf8'),
);
const texts = [...english.english].sort((a, b) => b.text.length - a.text.length).slice(0, 100);

const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();
// Languages per stored tooltip: all 13 for 1 and 15 tooltips; 6 for 100, the most that keeps
// that upload's /save under its 2 MB request cap at these text sizes.
let languageCount: number = languages.length;
function stored(index: number, de: string): Tooltip {
  const text = texts[index]!.text;
  const entry = (lang: string) => ({
    text: lang === 'de' ? de : `${lang}: ${text}`,
    updatedAt: at(3),
    updatedBy: 'gail',
    ...(lang === 'en' ? {} : { sourceUpdatedAt: at(2) }),
  });
  return {
    hash: 100_000 + index,
    text: Object.fromEntries(
      languages
        .slice(0, languageCount)
        .map((lang) => [lang, lang === 'en' ? { ...entry('en'), updatedAt: at(2) } : entry(lang)]),
    ),
    associated: [],
  };
}

it('measures translation manager route CPU', { timeout: 600_000 }, async () => {
  const fixture = new Fixture(await makePrivateKey());
  const users: Permissions['users'] = { '1': { login: 'alice', role: 'maintainer' } };
  // A large team: 200 accounts, 150 of them translators across the languages.
  for (let id = 10; id < 210; id++)
    users[String(id)] =
      id < 160
        ? { login: `t${id}`, role: 'translator', languages: [languages[1 + (id % 11)]!, 'de'] }
        : { login: `e${id}`, role: 'editor' };
  users['5'] = { login: 'erin', role: 'translator', languages: ['de', 'fr'], manages: ['de'] };
  fixture.accounts = { newbie: { id: 999, login: 'newbie', type: 'User' } };
  fixture.moveData({
    'config/permissions.json': { users },
    '.publisher/PIN': {
      capabilities: ['elementTags', 'markupBraces', 'numberTokens', 'sandboxPointers'],
    },
  });
  const original = fixture.fetch.bind(fixture);
  let mockMs = 0;
  let requests = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    requests++;
    try {
      return await original(input, init);
    } finally {
      mockMs += performance.now() - start;
    }
  });
  publisherConfig.enabled = true;
  const results: Record<string, unknown> = {
    note: 'Node CPU proxy; fixture GitHub time subtracted',
    largestEnglish: texts[0]!.text.length,
    smallestOf100: texts[99]!.text.length,
  };
  const time = async (
    run: () => Promise<Response>,
    status: number,
  ): Promise<{ ms: number; requests: number }> => {
    mockMs = 0;
    requests = 0;
    const start = performance.now();
    const response = await run();
    const body = await response.text();
    const ms = performance.now() - start - mockMs;
    expect(response.status, body).toBe(status);
    return { ms, requests };
  };
  const record = async (
    name: string,
    setup: () => void,
    run: () => Promise<Response>,
    status = 200,
  ) => {
    const samples: { ms: number; requests: number }[] = [];
    for (let i = 0; i < 11; i++) {
      setup();
      samples.push(await time(run, status));
    }
    const warm = samples
      .slice(1)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    results[name] = {
      coldMs: +samples[0]!.ms.toFixed(3),
      warmMedianMs: +warm[5]!.toFixed(3),
      warmMaxMs: +warm.at(-1)!.toFixed(3),
      subrequests: samples[1]!.requests,
    };
  };
  const as = (path: string, method = 'GET', value?: unknown, id = 5, login = 'erin') =>
    fixture.request(path, method, value, id, login);
  try {
    await record(
      'translators-get',
      () => {},
      () => as('/translators/de'),
    );
    await record(
      'translators-add',
      () => fixture.moveData({ 'config/permissions.json': { users } }),
      () => as('/translators/de', 'POST', { login: 'newbie' }),
    );
    await record(
      'translators-remove',
      () => fixture.moveData({ 'config/permissions.json': { users } }),
      () => as('/translators/de/12', 'DELETE'),
    );
    for (const size of [1, 15, 100]) {
      languageCount = size === 100 ? 6 : languages.length;
      let upload = '';
      // Each sample: a fresh parent state, then the upload that changed every tooltip's German.
      const prepare = () =>
        fixture.moveData(
          Object.fromEntries(
            texts
              .slice(0, size)
              .map((_, i) => [`tooltips/${100_000 + i}.json`, stored(i, `Alt ${i}`)]),
          ),
        );
      const uploadChanges = () =>
        Object.fromEntries(
          texts.slice(0, size).map((t, i) => {
            const value = stored(i, `de: ${t.text}`);
            value.text.de = { ...value.text.de!, updatedAt: at(4), sourceUpdatedAt: at(2) };
            return [`tooltips/${100_000 + i}.json`, value];
          }),
        );
      await record(`save-${size}`, prepare, () => {
        const changes = texts.slice(0, size).map((t, i) => {
          const base = stored(i, `Alt ${i}`);
          const next = structuredClone(base);
          next.text.de = {
            ...next.text.de!,
            text: `de: ${t.text}`,
            updatedAt: at(4),
            sourceUpdatedAt: at(2),
          };
          return { hash: base.hash, base, next };
        });
        return as('/save', 'POST', { changes, message: 'Translate' });
      });
      const trailer = texts
        .slice(0, size)
        .map((_, i) => `${100_000 + i}=de`)
        .join(';');
      const setupUpload = () => {
        prepare();
        fixture.moveData(uploadChanges(), `Translate\n\nClarity-Changed: ${trailer}`);
        upload = fixture.dataHead;
      };
      await record(`rollback-plan-${size}`, setupUpload, () =>
        as(`/rollback/upload?commit=${upload}&lang=de`),
      );
      await record(`rollback-apply-${size}`, setupUpload, () =>
        as('/rollback/upload', 'POST', { commit: upload, lang: 'de' }),
      );
    }
    console.log(`MANAGERS_CPU ${JSON.stringify(results)}`);
    if (process.env.MANAGERS_CPU_OUT)
      writeFileSync(process.env.MANAGERS_CPU_OUT, JSON.stringify(results, null, 2));
  } finally {
    publisherConfig.enabled = false;
    vi.unstubAllGlobals();
  }
});
