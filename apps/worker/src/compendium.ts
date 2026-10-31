import { z } from 'zod';
import { GitHub } from './github.js';
import { HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

const runSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.string(),
  html_url: z.string().url(),
});
const runsSchema = z.object({ workflow_runs: z.array(runSchema) });
export async function compendiumRefresh(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  requireAccess(await permissions(github, await github.head()), user, ['maintainer', 'editor']);
  const env = github.env;
  const actions = new GitHub(
    {
      ...env,
      GITHUB_OWNER: env.COMPENDIUM_OWNER ?? env.GITHUB_OWNER,
      GITHUB_REPO: env.COMPENDIUM_REPO ?? 'Compendium-data',
    },
    { contents: 'read', actions: request.method === 'POST' ? 'write' : 'read' },
  );
  const ref = env.COMPENDIUM_REF ?? 'main';
  const workflow = encodeURIComponent(env.COMPENDIUM_WORKFLOW ?? 'compendium.yml');
  const path = `/actions/workflows/${workflow}`;
  const response = await actions.request(
    `${path}/runs?branch=${encodeURIComponent(ref)}&per_page=1`,
  );
  if (!response.ok)
    throw new HttpError(
      502,
      `Compendium workflow status failed (${response.status}); check the App installation and Actions permissions`,
    );
  const latest = runsSchema.parse(await response.json()).workflow_runs[0] ?? null;
  if (request.method === 'GET') return json({ run: latest });
  if (latest && latest.status !== 'completed') {
    return json({ requestedAt: latest.created_at, runId: latest.id }, 202);
  }
  const dispatch = await actions.request(`${path}/dispatches`, 'POST', { ref });
  if (!dispatch.ok)
    throw new HttpError(502, `Compendium refresh could not start (${dispatch.status})`);
  return json({ requestedAt: new Date().toISOString(), runId: null }, 202);
}
