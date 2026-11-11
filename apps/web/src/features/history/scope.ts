import { languages, type Lang, type Tooltip } from '@clarity/core';

export interface HistoryScope {
  languages: readonly Lang[];
  fields: readonly SharedField[];
}
export const sharedFields = ['associated', 'custom', 'archive', 'compendium'] as const;
type SharedField = (typeof sharedFields)[number];
export const englishScope: HistoryScope = { languages: ['en'], fields: sharedFields };

export function viewScope(language: Lang, readOnly: boolean): HistoryScope {
  return {
    languages: language === 'en' ? ['en'] : ['en', language],
    fields: readOnly ? [] : sharedFields,
  };
}

/** A projection is for display only; never use it as a replacement draft. */
export function projectHistory(value: Tooltip | null, scope: HistoryScope): Tooltip | null {
  if (!value) return null;
  const result: Tooltip = { hash: value.hash, text: {}, associated: [] };
  for (const language of scope.languages)
    if (value.text[language]) result.text[language] = value.text[language];
  for (const field of scope.fields) Object.assign(result, { [field]: value[field] });
  return result;
}

export interface RevisionChanges {
  languages: Lang[];
  fields: SharedField[];
}

/** Runs in the history worker, against the unfiltered predecessor. */
export function classifyRevision(before: Tooltip | null, after: Tooltip | null): RevisionChanges {
  return {
    languages: languages.filter(
      (language) =>
        JSON.stringify(before?.text[language]) !== JSON.stringify(after?.text[language]),
    ),
    fields: sharedFields.filter(
      (field) =>
        JSON.stringify(before?.[field] ?? (field === 'associated' ? [] : null)) !==
        JSON.stringify(after?.[field] ?? (field === 'associated' ? [] : null)),
    ),
  };
}

export function isRelevant(changes: RevisionChanges, scope: HistoryScope): boolean {
  return (
    changes.languages.some((language) => scope.languages.includes(language)) ||
    changes.fields.some((field) => scope.fields.includes(field))
  );
}

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<
  number,
  { resolve(value: RevisionChanges): void; reject(error: Error): void }
>();
export function classifyInWorker(
  before: Tooltip | null,
  after: Tooltip | null,
): Promise<RevisionChanges> {
  // Non-browser test environments have no Worker. Browser failures remain visible and retryable.
  if (typeof Worker === 'undefined') return Promise.resolve(classifyRevision(before, after));
  return new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; changes: RevisionChanges }>) => {
        pending.get(event.data.id)?.resolve(event.data.changes);
        pending.delete(event.data.id);
      };
      worker.onerror = () => {
        for (const request of pending.values())
          request.reject(new Error('History classification failed'));
        pending.clear();
        worker?.terminate();
        worker = undefined;
      };
    }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, kind: 'classify', before, after });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

/** The final trailer is authoritative for this display hint, including batch saves.
 * Unknown/malformed tokens fall back to body classification. Never used for writes.
 */
export function changesFromTrailer(message: string, hash: number): RevisionChanges | undefined {
  const line = message?.trimEnd().split(/\r?\n/).at(-1);
  if (!line?.startsWith('Clarity-Changed: ')) return;
  const entries = line.slice('Clarity-Changed: '.length).split(';');
  const found = entries.filter((entry) => entry.startsWith(`${hash}=`));
  if (found.length !== 1) return;
  const tokens = found[0].slice(String(hash).length + 1).split(',');
  if (tokens.length === 1 && tokens[0] === 'none') return { languages: [], fields: [] };
  const result: RevisionChanges = { languages: [], fields: [] };
  for (const token of tokens) {
    if (languages.includes(token as Lang)) result.languages.push(token as Lang);
    else if (token === 'associations') result.fields.push('associated');
    else if (sharedFields.includes(token as SharedField) && token !== 'associated')
      result.fields.push(token as SharedField);
    else return;
  }
  return result;
}
