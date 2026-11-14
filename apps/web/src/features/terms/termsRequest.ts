import {
  compileTerms,
  matchTerms,
  type CompiledTerms,
  type TermEntry,
  type TermMatch,
} from './match';

/** A terms request to the diagnostics worker: the list travels once per id, then only its id. */
export interface TermsRequest {
  listId: string;
  /** Present the first time this list goes to the worker (or when the worker asks again). */
  entries?: readonly TermEntry[];
  text: string;
}
export type TermsReply = { matches: TermMatch[] } | { unknownList: true };

/** Compiled lists by id, oldest first; a few languages' lists at most. */
const listLimit = 4;

export function createTermsHandler() {
  const compiled = new Map<string, CompiledTerms>();
  return (request: TermsRequest): TermsReply => {
    let terms = compiled.get(request.listId);
    if (!terms) {
      if (!request.entries) return { unknownList: true };
      terms = compileTerms(request.entries);
      if (compiled.size >= listLimit) compiled.delete(compiled.keys().next().value!);
      compiled.set(request.listId, terms);
    }
    return { matches: matchTerms(request.text, terms) };
  };
}
