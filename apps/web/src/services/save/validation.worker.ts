import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { validateChanges } from './validation';

let snapshot: { revision: number; data: EditorData } | undefined;
self.onmessage = (
  event: MessageEvent<{
    id: number;
    revision: number;
    changes: Change[];
    data?: EditorData;
  }>,
) => {
  const { id, revision, changes, data } = event.data;
  try {
    if (data) snapshot = { revision, data };
    if (!snapshot || snapshot.revision !== revision)
      throw new Error('Save catalogue snapshot missing.');
    self.postMessage({ id, issues: validateChanges(changes, snapshot.data) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
