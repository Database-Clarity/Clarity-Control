import { markupImports, type MarkupGlobals } from '@clarity/core';
import type { DiagnosticInput, DiagnosticResult } from './diagnosticRequest';
import { compileTerms, matchTerms, type CompiledTerms, type TermMatch } from '../terms/match';
import type { TermsReply, TermsRequest } from '../terms/termsRequest';
import type { TermList } from '../terms/termList';

interface Snapshot {
  key: string;
  globals: MarkupGlobals;
  references: [string, string | undefined][];
}
const snapshots: Snapshot[] = [];

/** Snapshot only reachable imports; never enumerate the catalogue's lazy imports record. */
export function diagnosticGlobals(text: string, globals: MarkupGlobals): MarkupGlobals {
  const roots = [text, globals.variables, globals.titles].flatMap(markupImports);
  const key = JSON.stringify([globals.variables, globals.titles, globals.type, roots]);
  const cached = snapshots.find(
    (entry) =>
      entry.key === key &&
      entry.references.every(([hash, value]) => globals.imports?.[hash] === value),
  );
  if (cached) return cached.globals;
  const imports: Record<string, string> = {};
  const visited = new Set<string>();
  const references: Snapshot['references'] = [];
  const pending = [...roots];
  for (let index = 0; index < pending.length; index++) {
    const hash = pending[index].match(/ from (\d+|global) *$/)?.[1];
    if (!hash) continue;
    for (const source of hash === 'global' ? ['global', '1'] : [hash]) {
      if (visited.has(source)) continue;
      visited.add(source);
      const value = globals.imports?.[source];
      references.push([source, value]);
      if (value !== undefined) {
        imports[source] = value;
        pending.push(...markupImports(value));
      }
    }
  }
  const snapshot = {
    variables: globals.variables,
    titles: globals.titles,
    type: globals.type,
    imports,
  };
  if (snapshots.length >= 16) snapshots.shift();
  snapshots.push({ key, globals: snapshot, references });
  return snapshot;
}

let worker: Worker | undefined;
let failed = false;
let sequence = 0;
const jobs = new Map<number, { resolve(result: never): void; reject(error: Error): void }>();
const results = new WeakMap<MarkupGlobals, Map<string, Promise<DiagnosticResult>>>();

export const hasDiagnosticWorker = () => !failed && typeof Worker !== 'undefined';

function getWorker() {
  if (!hasDiagnosticWorker()) throw new Error('Markup worker unavailable');
  if (worker) return worker;
  worker = new Worker(new URL('./diagnostics.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (
    event: MessageEvent<{ id: number; result?: DiagnosticResult | TermsReply; error?: string }>,
  ) => {
    const job = jobs.get(event.data.id);
    if (!job) return;
    jobs.delete(event.data.id);
    if (event.data.result) job.resolve(event.data.result as never);
    else job.reject(new Error(event.data.error ?? 'Markup diagnostics failed'));
  };
  worker.onerror = () => {
    failed = true;
    worker?.terminate();
    worker = undefined;
    for (const job of jobs.values()) job.reject(new Error('Markup worker unavailable'));
    jobs.clear();
  };
  return worker;
}

export function requestDiagnostics(input: DiagnosticInput): Promise<DiagnosticResult> {
  const globals = diagnosticGlobals(input.text, input.globals);
  let cache = results.get(globals);
  if (!cache) results.set(globals, (cache = new Map()));
  const key = JSON.stringify([
    input.text,
    input.lang,
    input.requireEnglish,
    input.selfHash,
    input.sourceText,
  ]);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = new Promise<DiagnosticResult>((resolve, reject) => {
    const id = ++sequence;
    try {
      const target = getWorker();
      jobs.set(id, { resolve, reject });
      target.postMessage({ id, input: { ...input, globals } });
    } catch (error) {
      jobs.delete(id);
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, promise);
  return promise;
}

/** Lists the worker holds (same limit and order as termsRequest.ts, so both forget alike). */
const sentLists: string[] = [];
const termResults = new Map<string, Promise<TermMatch[]>>();
const localLists = new WeakMap<TermList, CompiledTerms>();

function postTerms(request: TermsRequest): Promise<TermsReply> {
  return new Promise<TermsReply>((resolve, reject) => {
    const id = ++sequence;
    try {
      const target = getWorker();
      jobs.set(id, { resolve: resolve as (result: never) => void, reject });
      target.postMessage({ id, terms: request });
    } catch (error) {
      jobs.delete(id);
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Without the worker (or after it failed): the same matcher on this thread, compiled once. */
function matchHere(list: TermList, text: string): TermMatch[] {
  let compiled = localLists.get(list);
  if (!compiled) localLists.set(list, (compiled = compileTerms(list.terms)));
  return matchTerms(text, compiled);
}

/**
 * The terms of `list` in `text` (the English a translator reads), matched in the diagnostics
 * worker. The list goes to the worker once; later requests send only its id. Results are kept
 * per list and text, so going back to a tooltip is a lookup.
 */
export function requestTermMatches(list: TermList, text: string): Promise<TermMatch[]> {
  const key = `${list.id}\u0000${text}`;
  const cached = termResults.get(key);
  if (cached) return cached;
  const run = async (): Promise<TermMatch[]> => {
    if (!hasDiagnosticWorker()) return matchHere(list, text);
    const known = sentLists.includes(list.id);
    try {
      let reply = await postTerms({
        listId: list.id,
        entries: known ? undefined : list.terms,
        text,
      });
      if (!known) {
        if (sentLists.length >= 4) sentLists.shift();
        sentLists.push(list.id);
      }
      if ('unknownList' in reply)
        reply = await postTerms({ listId: list.id, entries: list.terms, text });
      return 'matches' in reply ? reply.matches : matchHere(list, text);
    } catch {
      return matchHere(list, text);
    }
  };
  const promise = run();
  if (termResults.size >= 64) termResults.delete(termResults.keys().next().value!);
  termResults.set(key, promise);
  return promise;
}
