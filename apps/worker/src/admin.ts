import { z } from 'zod';
import { permissionsSchema, stableStringify, tooltipSchema } from '@clarity/core';
import { RefRace, type GitHub } from './github.js';
import { body, hashParam, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';
import { historySchema, pushedVersion } from './history.js';

const permissionsUpdateSchema = z
  .object({ revision: z.string().regex(/^[0-9a-f]{40}$/), permissions: permissionsSchema })
  .strict();

/**
 * GET returns the permissions with the blob SHA they were read at (`revision`). PUT must send that
 * revision back; if the stored permissions have since changed - checked again on every ref-race
 * retry - the update is refused with 409 rather than overwriting (and so un-revoking) newer access.
 */
export async function managePermissions(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const input = request.method === 'PUT' ? await body(request, permissionsUpdateSchema) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const file = await github.requiredFile('config/permissions.json', head);
    const current = permissionsSchema.parse(file.value);
    requireAccess(current, user, ['maintainer']);
    if (!input) return json({ revision: file.sha, permissions: current });
    if (input.revision !== file.sha) {
      throw new HttpError(409, 'Permissions changed since they were loaded; reload and retry');
    }
    const next = input.permissions;
    // Partner membership changes only through PUT /exports/projects/:id/partners (logins resolved
    // to ids there). A client that drops or edits `partners` here (an older bundle) is refused.
    if (stableStringify(next.partners ?? null) !== stableStringify(current.partners ?? null)) {
      throw new HttpError(400, 'Export partners are managed on the exports page');
    }
    if (!Object.values(next.users).some((access) => access.role === 'maintainer')) {
      throw new HttpError(400, 'At least one maintainer must remain');
    }
    try {
      const commit = await github.commit(
        head,
        {
          'config/permissions.json': next,
        },
        `Update editor permissions by ${user.login}`,
        user,
      );
      const saved = await github.requiredFile('config/permissions.json', commit);
      return json({ commit, revision: saved.sha, permissions: next });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload permissions and retry');
}

export async function history(
  request: Request,
  github: GitHub,
  user: Identity,
  rawHash: string,
): Promise<Response> {
  const hash = hashParam(rawHash);
  const url = new URL(request.url);
  const commit = url.searchParams.get('commit');
  const head = await github.head();
  requireAccess(await permissions(github, head), user, [
    'maintainer',
    'editor',
    'trial',
    'translator',
  ]);
  if (url.searchParams.get('live') === '1') return pushedVersion(github, hash, head);
  if (commit) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new HttpError(400, 'Invalid commit SHA');
    const file = await github.file(`tooltips/${hash}.json`, commit);
    if (!file) throw new HttpError(404, 'Tooltip did not exist at that commit');
    const tooltip = tooltipSchema.parse(file.value);
    if (tooltip.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
    return json({ commit, tooltip });
  }
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, 'Invalid page');
  const query = new URLSearchParams({
    sha: github.env.DATA_BRANCH,
    path: `tooltips/${hash}.json`,
    per_page: '30',
    page: String(page),
  });
  const commits = historySchema.parse(await github.result(`/commits?${query}`));
  return json({
    page,
    commits: commits.map((entry) => ({
      commit: entry.sha,
      author: entry.author?.login ?? entry.commit.author?.name ?? null,
      login: entry.author?.login ?? null,
      avatar: entry.author?.avatar_url ?? null,
      date: entry.commit.author?.date ?? null,
      message: entry.commit.message,
    })),
  });
}
