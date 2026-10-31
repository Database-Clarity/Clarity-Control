import { ZodError } from 'zod';
import { callback, identity, login } from './auth.js';
import { managePermissions, history } from './admin.js';
import { compendiumRefresh } from './compendium.js';
import { GitHub } from './github.js';
import { HttpError, json } from './http.js';
import { permissions } from './permissions.js';
import { pushLive } from './push.js';
import { save } from './save.js';
import type { Context, Env } from './types.js';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/auth/login') return login(env);
  if (request.method === 'GET' && path === '/auth/callback') return callback(request, env);
  const user = await identity(request, env);
  const github = new GitHub(env);
  if (
    (request.method === 'POST' && path === '/compendium/refresh') ||
    (request.method === 'GET' && path === '/compendium/refresh/status')
  ) {
    return compendiumRefresh(request, github, user);
  }
  if (request.method === 'GET' && path === '/me') {
    const access = (await permissions(github, await github.head())).users[String(user.id)];
    return json({
      id: user.id,
      login: user.login,
      role: access?.role ?? null,
      languages: access?.languages ?? [],
    });
  }
  if (request.method === 'POST' && path === '/save') return save(request, github, user);
  if (request.method === 'POST' && path === '/push-live') return pushLive(request, github, user);
  if (['GET', 'PUT'].includes(request.method) && path === '/permissions') {
    return managePermissions(request, github, user);
  }
  const item = /^\/history\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && item) return history(request, github, user, item[1]);
  throw new HttpError(404, 'Endpoint not found');
}

const worker: { fetch(request: Request, env: Env, context: Context): Promise<Response> } = {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = !origin || [env.SITE_ORIGIN, 'http://localhost:5173'].includes(origin);
    let response: Response;
    try {
      if (!allowed) throw new HttpError(403, 'Origin not allowed');
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204 });
      } else {
        response = await route(request, env);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(
          {
            error: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
          error.status,
        );
      } else {
        console.error(
          'Worker request failed',
          error instanceof ZodError
            ? error.issues
            : error instanceof Error
              ? error.message
              : 'Unknown error',
        );
        response = json(
          { error: error instanceof ZodError ? 'Invalid upstream data' : 'Internal server error' },
          502,
        );
      }
    }
    const headers = new Headers(response.headers);
    headers.append('Vary', 'Origin');
    if (origin && allowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '600');
    }
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },
};
export default worker;
