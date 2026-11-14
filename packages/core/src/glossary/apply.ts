import { stableStringify } from '../contentHash.js';
import {
  glossaryEntrySchema,
  glossaryKey,
  maxGlossaryTerms,
  type Glossary,
  type GlossaryEntry,
  type GlossaryOp,
} from './schema.js';

export interface GlossaryConflict {
  key: string;
  head: GlossaryEntry | null;
}
/** Per-entry CAS allows concurrent edits of different terms, and applies a batch atomically. */
export function applyGlossary(
  current: Glossary,
  ops: readonly GlossaryOp[],
  updatedAt: string,
  updatedBy: string,
): { glossary: Glossary; conflicts: GlossaryConflict[] } {
  const conflicts = ops.flatMap((op) => {
    const head = Object.hasOwn(current.terms, op.key) ? current.terms[op.key]! : null;
    if (head !== null) {
      const parsed = glossaryEntrySchema.safeParse(head);
      if (!parsed.success || glossaryKey(parsed.data.en) !== op.key)
        throw new Error('Invalid stored glossary entry');
    }
    return stableStringify(head) === stableStringify(op.base) ? [] : [{ key: op.key, head }];
  });
  if (conflicts.length) return { glossary: current, conflicts };
  const terms = { ...current.terms };
  for (const op of ops) {
    if (op.next === null) delete terms[op.key];
    else terms[op.key] = glossaryEntrySchema.parse({ ...op.next, updatedAt, updatedBy });
  }
  if (Object.keys(terms).length > maxGlossaryTerms)
    throw new RangeError(
      `This language’s glossary is limited to ${maxGlossaryTerms} terms. Remove an entry before adding another.`,
    );
  return { glossary: { ...current, terms }, conflicts: [] };
}
