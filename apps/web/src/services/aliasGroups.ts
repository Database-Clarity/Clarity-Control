import { aliasGroupsResponseSchema, type AliasGroupsResponse } from '@clarity/core';
import { z } from 'zod';
import { apiRequest } from './api';

const headSchema = z.object({ head: aliasGroupsResponseSchema.shape.head });

async function checked<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (response.ok) return schema.parse(await response.json());
  let detail = `HTTP ${response.status}`;
  try {
    const value = (await response.json()) as { error?: string };
    detail = value.error ?? detail;
  } catch {
    /* Keep the status when an upstream response is not JSON. */
  }
  // 422: the removal is refused for a stated reason, so trying again cannot help.
  throw Object.assign(new Error(detail), { refused: response.status === 422 });
}

/** The data head a removal's confirm was opened at: its CAS (the Worker refuses a moved head). */
export async function getAliasGroupsHead(signal?: AbortSignal): Promise<string> {
  const response = await apiRequest('/alias-groups?head=1', { signal });
  return (await checked(response, headSchema)).head;
}

/** Take one non-canonical member out of its group (it starts as a copy of the group's text). */
export async function removeGroupMember(
  expectedHead: string,
  canonical: number,
  member: number,
): Promise<AliasGroupsResponse> {
  return checked(
    await apiRequest('/alias-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedHead,
        ops: [{ op: 'removeMember', canonical, member }],
      }),
    }),
    aliasGroupsResponseSchema,
  );
}
