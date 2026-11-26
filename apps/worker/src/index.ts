import publisherConfig from '../../../config/publisher.json';
import { permissionsSchema, translationPublishContract } from '@clarity/core';
import { ZodError } from 'zod';
import { agentGuidance } from './agentGuidance.js';
import { callback, identity, login, siteOrigins } from './auth.js';
import { managePermissions, history } from './admin.js';
import { compendiumRefresh } from './compendium.js';
import { exportsRoute } from './exports.js';
import { GitHub } from './github.js';
import { glossaryRoute } from './glossary.js';
import { HttpError, json } from './http.js';
import { managedLanguages, partnerProjects, permissions, roleOf } from './permissions.js';
import { rollbackUpload, translatorsRoute } from './managers.js';
import { publish, publishKey, publishStatus, publishKick } from './publish.js';
import { publishAck, publishMine } from './publishAccount.js';
import {
  translationPartRows,
  translationPublishEnabled,
  translationReadinessPaths,
  translationRoots,
  wantsTranslationContract,
} from './translationPublish.js';
import { pushLive } from './push.js';
import { sandboxPointersRoute } from './sandboxPointers.js';
import { inactiveMovesRoute } from './inactiveMoves.js';
import { marksRoute } from './marks.js';
import { aliasGroupsRoute } from './aliasGroups.js';
import { save } from './save.js';
import { stageCurrentSave } from './currentSaveStage.js';
import { globalsRoute, isGlobalsPath, refuseGlobalsWhenOff } from './globalsRoute.js';
import { reports, purgeReports } from './reports.js';
import { batchesRoute, isBatchPath, refuseWhenOff } from './schedule/routes.js';
import { minuteCron, scheduleTick } from './schedule/lifecycle.js';
import { switches } from './schedule/store.js';
import { userWorklists } from './worklists.js';
import { personalSnippetsRoute, teamSnippetsRoute } from './snippets.js';
import { localizedSnippetsRoute } from './localizedSnippets.js';
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
  if (isBatchPath(path)) refuseWhenOff();
  if (isGlobalsPath(path)) refuseGlobalsWhenOff();
  const user = await identity(request, env);
  const github = new GitHub(env);
  if (['GET', 'POST'].includes(request.method) && path === '/alias-groups')
    return aliasGroupsRoute(request, github, user);
  const glossary = /^\/glossary\/([^/]+)$/.exec(path);
  if (glossary && ['GET', 'POST'].includes(request.method))
    return glossaryRoute(request, github, user, glossary[1]);
  if (isBatchPath(path)) return batchesRoute(request, path, github, user);
  if (isGlobalsPath(path)) return globalsRoute(request, github, user);
  if (request.method === 'POST' && path === '/publish') return publish(request, github, user);
  if (request.method === 'GET' && path === '/publish/status')
    return publishStatus(request, github, user);
  if (request.method === 'GET' && path === '/publish/mine') return publishMine(github, user);
  if (request.method === 'POST' && path === '/publish/ack')
    return publishAck(request, github, user);
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
    const scoped =
      publisherConfig.enabled && translationPublishEnabled(env) && wantsTranslationContract(url)
        ? await github.publishSnapshot(['config/permissions.json', ...translationReadinessPaths])
        : undefined;
    const config = scoped
      ? permissionsSchema.parse(scoped.files[0]?.value)
      : await permissions(github, await github.head());
    const projects = partnerProjects(config, user);
    const manages = managedLanguages(config.users[String(user.id)]);
    const role = roleOf(config, user);
    const ready =
      scoped && role === 'translator' && translationRoots(scoped.files.slice(1), env.LIVE_BRANCH);
    return json({
      id: user.id,
      login: user.login,
      role,
      schedulePreparation: switches.preparation(),
      ...(github.env.COMPENDIUM_DECISION_WRITES === '1' ? { compendiumDecisions: true } : {}),
      languages: config.users[String(user.id)]?.languages ?? [],
      ...(manages.length ? { manages } : {}),
      ...(projects.length ? { projects } : {}),
      ...(ready
        ? {
            translationPublish: {
              version: translationPublishContract,
              partRows: translationPartRows,
            },
          }
        : {}),
    });
  }
  if (path === '/exports/projects' || path.startsWith('/exports/projects/')) {
    const handled = exportsRoute(request, path, github, user);
    if (handled) return handled;
  }
  if (request.method === 'POST' && path === '/save') return save(request, github, user);
  if (path === '/save/stage') return stageCurrentSave(request, github, user);
  if (request.method === 'POST' && path === '/push-live') return pushLive(request, github, user);
  const worklist = /^\/worklists\/([^/]+)$/.exec(path);
  const personalSnippet = /^\/snippets\/mine\/([^/]+)$/.exec(path);
  const snippetLocale = /^\/snippets\/local\/([^/]+)$/.exec(path);
  if (snippetLocale && ['GET', 'PUT'].includes(request.method))
    return localizedSnippetsRoute(request, github, user, snippetLocale[1]);
  if ((path === '/snippets/mine' || personalSnippet) && ['GET', 'PUT'].includes(request.method))
    return personalSnippetsRoute(request, github, user, personalSnippet?.[1]);
  if (path === '/snippets/team' && ['GET', 'PUT'].includes(request.method))
    return teamSnippetsRoute(request, github, user);
  if (path === '/snippets/team/copy' && request.method === 'POST')
    return teamSnippetsRoute(request, github, user, true);
  if ((path === '/worklists' || worklist) && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
    return userWorklists(request, github, user, worklist?.[1]);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/settings') {
    return userSettings(request, github, user);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/permissions') {
    return managePermissions(request, github, user);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/sandbox-pointers') {
    return sandboxPointersRoute(request, github, user);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/inactive-moves') {
    return inactiveMovesRoute(request, github, user);
  }
  if (['GET', 'PUT'].includes(request.method) && path === '/marks') {
    return marksRoute(request, github, user);
  }
  const translators = /^\/translators\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (translators && ['GET', 'POST', 'DELETE'].includes(request.method))
    return translatorsRoute(request, github, user, translators[1]!, translators[2]);
  if (['GET', 'POST'].includes(request.method) && path === '/rollback/upload')
    return rollbackUpload(request, github, user);
  const item = /^\/history\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && item) return history(request, github, user, item[1]);
  throw new HttpError(404, 'Endpoint not found');
}

const worker: {
  fetch(request: Request, env: Env, context: Context): Promise<Response>;
  scheduled(event: { cron?: string }, env: Env, context: Context): void;
} = {
  // Dispatch by trigger: the per-minute trigger (gate G1, phase P5) only drives scheduled
  // batches; every other trigger keeps today's hourly report purge, so it stays hourly.
  scheduled(event, env, context) {
    if (event?.cron === minuteCron) context.waitUntil(scheduleTick(env));
    else context.waitUntil(purgeReports(env));
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
          error instanceof Error || error instanceof ZodError
            ? error.constructor.name
            : 'UnknownError',
          ...(error instanceof ZodError
            ? [
                {
                  issueCount: error.issues.length,
                  issueCodes: error.issues.map((issue) => issue.code),
                },
              ]
            : []),
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
      // The editor dates conflict answers by server time (Date), not by the browser clock.
      // Routes may expose their own headers (ETag); keep them.
      const exposed = (headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name && name.toLowerCase() !== 'date');
      headers.set('Access-Control-Expose-Headers', [...exposed, 'Date'].join(', '));
    }
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },
};
export default worker;
