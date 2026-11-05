import { markupImports, type MarkupGlobals } from '@clarity/core';
import type { DiagnosticInput, DiagnosticResult } from './diagnosticRequest';

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
const jobs = new Map<
  number,
  { resolve(result: DiagnosticResult): void; reject(error: Error): void }
>();
const results = new WeakMap<MarkupGlobals, Map<string, Promise<DiagnosticResult>>>();

export const hasDiagnosticWorker = () => !failed && typeof Worker !== 'undefined';

function getWorker() {
  if (!hasDiagnosticWorker()) throw new Error('Markup worker unavailable');
  if (worker) return worker;
  worker = new Worker(new URL('./diagnostics.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (
    event: MessageEvent<{ id: number; result?: DiagnosticResult; error?: string }>,
  ) => {
    const job = jobs.get(event.data.id);
    if (!job) return;
    jobs.delete(event.data.id);
    if (event.data.result) job.resolve(event.data.result);
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
  const key = JSON.stringify([input.text, input.lang, input.requireEnglish, input.selfHash]);
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
