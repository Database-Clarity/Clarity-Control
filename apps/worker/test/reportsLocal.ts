// Local confirmation adapter only. Never used by the production Wrangler entrypoint.
import { signToken } from '../src/crypto.js';
import { reportBudget } from './reportsBudget.js';
import type { Env, Context } from '../src/types.js';
const permissions = {
  users: { '1': { login: 'owner', role: 'maintainer' }, '5': { login: 'account', role: null } },
};
const head = '1'.repeat(40);
const catalogText = JSON.stringify({
  sourceCommit: head,
  items: Object.fromEntries(
    Array.from({ length: 1695 }, (_, i) => [
      i + 1,
      { owner: i + 1, langs: ['en', 'de', 'fr'], variant: 'base' },
    ]),
  ),
});
let key = '';
let network = 0;
globalThis.fetch = async (input: RequestInfo | URL) => {
  network++;
  const url = String(input);
  if (url.includes('report-items.worker.json')) return new Response(catalogText);
  if (url.includes('siteverify'))
    return new Response(
      JSON.stringify({ success: true, hostname: 'editor.example', action: 'report' }),
    );
  if (url.includes('/access_tokens'))
    return new Response(JSON.stringify({ token: 'local-test-token' }));
  if (url.includes('/git/ref/heads/'))
    return new Response(JSON.stringify({ object: { sha: head } }));
  if (url.includes('/contents/config/permissions.json'))
    return new Response(
      JSON.stringify({
        sha: head,
        encoding: 'base64',
        content: btoa(JSON.stringify({ users: { '1': permissions.users['1'] } })),
      }),
    );
  throw new Error(`Unmocked local upstream ${url}`);
};
export default {
  async fetch(request: Request, bindings: Env, context: Context) {
    const path = new URL(request.url).pathname;
    const env = {
      ...bindings,
      SITE_ORIGIN: 'https://editor.example',
      SESSION_SECRET: 'local-test-session-secret-not-for-production-0000',
      GITHUB_PRIVATE_KEY: key,
      TURNSTILE_SECRET: 'local-test-turnstile',
    };
    if (path === '/__configure') {
      key = await request.text();
      return Response.json({ ok: true });
    }
    if (path === '/__sql') {
      const value = (await request.json()) as { sql: string; files?: boolean };
      await (value.files ? env.REPORTS_FILES_DB : env.REPORTS_DB)!.prepare(value.sql).run();
      return Response.json({ ok: true });
    }
    if (path === '/__token') {
      const id = Number(new URL(request.url).searchParams.get('id'));
      return Response.json({
        token: await signToken(
          { purpose: 'session', id, login: `user${id}`, exp: Math.floor(Date.now() / 1000) + 3600 },
          env.SESSION_SECRET,
        ),
      });
    }
    const start = network;
    const result = await reportBudget(request, env, context);
    const response = new Response(result.response.body, result.response);
    response.headers.set('X-Local-Handler-Proxy-Ms', String(result.handlerMs));
    response.headers.set('X-Local-D1-Awaited-Ms', String(result.dbMs));
    response.headers.set('X-Local-Subrequests', String(result.dbCalls + network - start));
    return response;
  },
};
