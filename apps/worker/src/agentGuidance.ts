import { guidanceSchema } from '@clarity/core';
import { z } from 'zod';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

const path = 'agent-guidance/compendium.json';
const inputSchema = z
  .object({
    document: guidanceSchema,
    revision: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
  })
  .strict();

export async function agentGuidance(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  if (
    github.env.DATA_BRANCH !== 'editor-data' ||
    github.env.GITHUB_OWNER !== 'Database-Clarity' ||
    github.env.GITHUB_REPO !== 'Live-Clarity-Database'
  ) {
    throw new HttpError(503, 'Guidance destination is not configured');
  }
  const head = await github.head();
  requireAccess(await permissions(github, head), user, ['maintainer']);
  const current = await github.file(path, head);
  if (request.method === 'GET')
    return json({ revision: current?.sha ?? null, document: current?.value ?? null });
  const input = await body(request, inputSchema);
  if (input.revision !== (current?.sha ?? null))
    throw new HttpError(409, 'Guidance changed; reload before sending');
  try {
    const commit = await github.commit(
      head,
      { [path]: input.document },
      'Send Compendium guidance to agents',
      user,
    );
    return json({
      commit,
      url: `https://github.com/Database-Clarity/Live-Clarity-Database/commit/${commit}`,
    });
  } catch (error) {
    if (error instanceof RefRace)
      throw new HttpError(409, 'Data branch changed; reload before sending');
    throw error;
  }
}
