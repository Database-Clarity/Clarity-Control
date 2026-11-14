import { z } from 'zod';
import type { Lang } from '@clarity/core';
import {
  glossarySchema,
  glossaryEntrySchema,
  type GlossaryOp,
} from '../../../../packages/core/src/glossary/schema';
import { apiRequest, failure } from './apiAuth';

export const glossaryResponseSchema = z.object({
  revision: z.string().nullable(),
  glossary: glossarySchema,
});
export type GlossaryResponse = z.infer<typeof glossaryResponseSchema>;
function parseResponse(value: unknown, lang: Lang): GlossaryResponse {
  const remote = glossaryResponseSchema.parse(value);
  if (remote.glossary.lang !== lang) throw new Error('Glossary language mismatch');
  return remote;
}
export class GlossaryConflictError extends Error {
  constructor(
    readonly conflicts: { key: string; head: z.infer<typeof glossaryEntrySchema> | null }[],
  ) {
    super('This term changed. Choose which version to keep.');
  }
}
export async function getGlossary(lang: Lang): Promise<GlossaryResponse> {
  const response = await apiRequest(`/glossary/${lang}`);
  if (!response.ok) return failure(response);
  return parseResponse(await response.json(), lang);
}
export async function postGlossary(lang: Lang, ops: GlossaryOp[]): Promise<GlossaryResponse> {
  const response = await apiRequest(`/glossary/${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops }),
  });
  if (response.status === 409) {
    const value = z
      .object({
        conflicts: z.array(z.object({ key: z.string(), head: glossaryEntrySchema.nullable() })),
      })
      .safeParse(await response.json());
    if (value.success) throw new GlossaryConflictError(value.data.conflicts);
    throw new Error('Glossary changed; retry the save');
  }
  if (!response.ok) return failure(response);
  return parseResponse(await response.json(), lang);
}
