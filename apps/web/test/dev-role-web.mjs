import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export { createServer } from 'vite';

export const localPath = '/__clarity-local-role-harness';
export const localChallenge = 'clarity-local-turnstile';
const upstreamHosts = ['raw.githubusercontent.com', 'api.github.com', 'data.d2clarity.com'];
const chooser = readFileSync(
  new URL('../../../scripts/dev-roles/chooser.mjs', import.meta.url),
  'utf8',
);
const challenge = `
const widgets = new Map();
window.turnstile = {
  render(_element, options) {
    const id = crypto.randomUUID();
    widgets.set(id, options.callback);
    return id;
  },
  execute(id) { widgets.get(id)?.(${JSON.stringify(localChallenge)}); },
  reset() {},
  remove(id) { widgets.delete(id); },
};
`;

function send(response, code, body, type = 'application/json') {
  response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
}

const workerRequestHeaders = [
  'authorization',
  'content-type',
  'if-none-match',
  'x-report-request-id',
];

export function rolePlugin({ origin, roles, issue, upstream, dispatch }) {
  const { host: loopbackHost, hostname: loopbackIp } = new URL(origin);
  async function handle(req, res, next) {
    const url = new URL(req.url, origin);
    if (req.headers.host !== loopbackHost || url.origin !== origin)
      return send(res, 403, '{"error":"Use the loopback development URL"}');

    res.setHeader(
      'Content-Security-Policy',
      "connect-src 'self'; form-action 'self'; object-src 'none'",
    );
    if (!url.pathname.startsWith(`${localPath}/`)) return next();
    if (req.headers.origin && req.headers.origin !== origin)
      return send(res, 403, '{"error":"Origin not allowed"}');

    const route = url.pathname.slice(localPath.length);
    if (route === '/chooser.mjs' && req.method === 'GET')
      return send(res, 200, chooser, 'text/javascript');
    if (route === '/turnstile.js' && req.method === 'GET')
      return send(res, 200, challenge, 'text/javascript');
    if (route === '/roles' && req.method === 'GET') {
      return send(res, 200, JSON.stringify([...roles].map(([key, { label }]) => ({ key, label }))));
    }
    if (route === '/session' && req.method === 'POST') {
      if (req.headers.origin !== origin)
        return send(res, 403, '{"error":"A same-origin request is required"}');
      const identity = roles.get(url.searchParams.get('role'));
      if (!identity) return send(res, 400, '{"error":"Unknown local identity"}');
      return send(res, 200, JSON.stringify({ token: await issue(identity) }));
    }
    if (route === '/api/auth/login' && req.method === 'GET')
      return res.writeHead(303, { Location: '/?dev-role=choose' }).end();
    if (route.startsWith('/api/auth/'))
      return send(res, 404, '{"error":"Use the local role switcher"}');

    let result;
    if (route.startsWith('/api/')) {
      const target = new URL(origin);
      target.pathname = route.slice('/api'.length);
      target.search = url.search;
      const headers = new Headers();
      for (const name of workerRequestHeaders) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      headers.set('origin', origin);
      headers.set('CF-Connecting-IP', loopbackIp);
      const body =
        req.method === 'GET' || req.method === 'HEAD' ? {} : { body: req, duplex: 'half' };
      result = await dispatch(target.href, { method: req.method, headers, ...body });
    } else if (route.startsWith('/upstream/') && ['GET', 'HEAD'].includes(req.method)) {
      const [, , host, ...path] = route.split('/');
      if (!upstreamHosts.includes(host))
        return send(res, 404, '{"error":"Unknown local upstream"}');
      const target = new URL(`https://${host}/`);
      target.pathname = '/' + path.join('/');
      target.search = url.search;
      result = await upstream(new Request(target, { method: req.method }));
    } else {
      return send(res, 404, '{"error":"Unknown local endpoint"}');
    }
    for (const [name, value] of result.headers) {
      if (['content-type', 'etag', 'date', 'content-disposition', 'retry-after'].includes(name))
        res.setHeader(name, value);
    }
    res.writeHead(result.status, { 'Cache-Control': 'no-store' });
    if (result.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(result.body), res);
    else res.end();
  }

  return {
    name: 'clarity-local-role-harness',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handle(req, res, next).catch((error) => {
          if (res.headersSent) return res.destroy();
          console.error('Local development request failed', error);
          send(res, 502, '{"error":"Local development request failed"}');
        });
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: `${localPath}/chooser.mjs` },
            injectTo: 'body',
          },
        ];
      },
    },
    transform(source, id) {
      if (!/\/apps\/web\/src\/.+\.[cm]?[jt]sx?$/.test(id.replaceAll('\\', '/').split('?')[0]))
        return;
      let code = source.replace(
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        `${localPath}/turnstile.js`,
      );
      for (const host of upstreamHosts)
        code = code.replaceAll(`https://${host}`, `${localPath}/upstream/${host}`);
      if (code !== source) return { code, map: null };
    },
  };
}
