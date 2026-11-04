import type { ValidationKind } from './jsonValidation';

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<
  number,
  { resolve(value: ArrayBuffer): void; reject(error: Error): void }
>();

/** Transfer bytes in both directions so large structured clones cannot block the UI. */
export function validateInWorker(kind: ValidationKind, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!worker) {
    worker = new Worker(new URL('./jsonValidation.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      event: MessageEvent<{ id: number; bytes?: ArrayBuffer; error?: string }>,
    ) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.bytes) request.resolve(event.data.bytes);
      else request.reject(new Error(event.data.error ?? 'JSON validation failed'));
    };
    worker.onerror = (event) => {
      for (const request of pending.values())
        request.reject(new Error(event.message || 'JSON validation worker failed'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker!.postMessage({ id, kind, bytes }, [bytes]);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}
