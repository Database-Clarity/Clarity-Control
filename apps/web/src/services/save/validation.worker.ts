import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import type { LiveFallback } from './fallback';
import { validateChanges } from './validation';
import { saveChunks } from './chunks';

let snapshot: { revision: number; data: EditorData } | undefined;
self.onmessage = (
  event: MessageEvent<{
    id: number;
    revision: number;
    changes: Change[];
    fallback?: LiveFallback;
    clearing?: boolean;
    data?: EditorData;
    plan?: { message: string; noTranslationImpact: boolean };
  }>,
) => {
  const { id, revision, changes, fallback, clearing, data, plan } = event.data;
  try {
    if (data) snapshot = { revision, data };
    if (!snapshot || snapshot.revision !== revision)
      throw new Error('Save catalogue snapshot missing.');
    self.postMessage(
      plan
        ? { id, chunks: saveChunks(changes, snapshot.data, plan.message, plan.noTranslationImpact) }
        : { id, issues: validateChanges(changes, snapshot.data, fallback, clearing) },
    );
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
