import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import type { LiveFallback } from './fallback';
import { validateChanges } from './validation';

let snapshot: { revision: number; data: EditorData } | undefined;
self.onmessage = (
  event: MessageEvent<{
    id: number;
    revision: number;
    changes: Change[];
    fallback?: LiveFallback;
    data?: EditorData;
  }>,
) => {
  const { id, revision, changes, fallback, data } = event.data;
  try {
    if (data) snapshot = { revision, data };
    if (!snapshot || snapshot.revision !== revision)
      throw new Error('Save catalogue snapshot missing.');
    self.postMessage({ id, issues: validateChanges(changes, snapshot.data, fallback) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
