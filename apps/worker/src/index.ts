import publisherConfig from '../../../config/publisher.json';
import { ZodError } from 'zod';
import { agentGuidance } from './agentGuidance.js';
import { callback, identity, login, siteOrigins } from './auth.js';
import { managePermissions, history } from './admin.js';
import { compendiumRefresh } from './compendium.js';
import { exportsRoute } from './exports.js';
import { GitHub } from './github.js';
import { HttpError, json } from './http.js';
import { partnerProjects, permissions, roleOf } from './permissions.js';
import { publish, publishKey, publishStatus, publishKick } from './publish.js';
import { pushLive } from './push.js';
import { save } from './save.js';
import { reports, purgeReports } from './reports.js';
import { userSettings } from './settings.js';
import type { Context, Env } from './types.js';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/auth/login') return login(request, env);
  if (request.method === 'GET' && path === '/auth/callback') return callback(request, env);
  if (path === '/reports' || path.startsWith('/reports/')) return reports(request, env);
  if (publisherConfig.enabled && path === '/push-live') throw new HttpError(410, 'Use /publish');
  if (!publisherConfig.enabled && ['/publish', '/publish/kick'].includes(path))
    throw new HttpError(503, 'Publisher is not enabled');
  if (request.method === 'GET' && path === '/publish/key') return publishKey(env);
  const user = await identity(request, env);
  const github = new GitHub(env);
  if (request.method === 'POST' && path === '/publish') return publish(request, github, user);
  if (request.method === 'GET' && path === '/publish/status')
    return publishStatus(request, github, user);
  if (request.method === 'POST' && path === '/publish/kick')
    return publishKick(request, github, user);
  if (
    (request.method === 'POST' && path === '/compendium/refresh') ||
    (request.method === 'GET' && path === '/compendium/refresh/status')
  ) {
    return compendiumRefresh(request, github, user);
  }
  if (['GET', 'POST'].includes(request.method) && path === '/compendium/agent-guidance')
    return agentGuidance(request, github, user);
  if (request.method === 'GET' && path === '/me') {
    const config = await permissions(github, await github.head());
    const projects = partnerProjects(config, user);
    return json({
      id: user.id,
      login: user.login,
      role: roleOf(config, user),
      languages: config.users[String(user.id)]?.languages ?? [],
      ...(projects.length ? { projects } : {}),
    });
  }
  if (path === '/exports/projects' || path.startsWith('/exports/projects/')) {
    const handled = exportsRoute(request, path, github, user);
    if (handled) return handled;
  }
  if (request.method === 'POST' && path === '/save') return save(request, github, user);
  if (request.method === 'POST' && path === '/push-live') return pushLive(request, github, user);
  if (['GET', 'PUT'].includes(request.method) && path === '/settings') {
    return userSettings(request, github, user);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/permissions') {
    return managePermissions(request, github, user);
  }
  const item = /^\/history\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && item) return history(request, github, user, item[1]);
  throw new HttpError(404, 'Endpoint not found');
}

const worker: {
  fetch(request: Request, env: Env, context: Context): Promise<Response>;
  scheduled(event: unknown, env: Env, context: Context): void;
} = {
  scheduled(_event, env, context) {
    context.waitUntil(purgeReports(env));
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = !origin || [...siteOrigins(env), 'http://localhost:5173'].includes(origin);
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
      const reportPath = /^\/reports(?:\/|$)/.test(new URL(request.url).pathname);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set(
        'Access-Control-Allow-Headers',
        reportPath
          ? 'Authorization, Content-Type, If-None-Match, X-Report-Request-Id'
          : 'Authorization, Content-Type',
      );
      headers.set('Access-Control-Max-Age', '600');
    }
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },
};
export default worker;
