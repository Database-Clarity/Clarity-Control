import { aliasGroupsResponseSchema, type AliasGroupsResponse } from '@clarity/core';
import { apiRequest } from './api';

async function checked(response: Response): Promise<AliasGroupsResponse> {
  if (response.ok) return aliasGroupsResponseSchema.parse(await response.json());
  let detail = `HTTP ${response.status}`;
  try {
    const value = (await response.json()) as { error?: string };
    detail = value.error ?? detail;
  } catch {
    /* Keep the status when an upstream response is not JSON. */
  }
  throw new Error(detail);
}

/** The maintainer snapshot of accepted groups; its head is the CAS for the next change. */
export async function getAliasGroups(signal?: AbortSignal) {
  return checked(await apiRequest('/alias-groups', { signal }));
}

/** Take one non-canonical member out of its group (it starts as a copy of the group's text). */
export async function removeGroupMember(expectedHead: string, canonical: number, member: number) {
  return checked(
    await apiRequest('/alias-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedHead,
        ops: [{ op: 'removeMember', canonical, member }],
      }),
    }),
  );
}
