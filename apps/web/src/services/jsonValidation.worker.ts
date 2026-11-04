import { validateJsonBytes, type ValidationKind } from './jsonValidation';

self.onmessage = (
  event: MessageEvent<{ id: number; kind: ValidationKind; bytes: ArrayBuffer }>,
) => {
  const { id, kind, bytes } = event.data;
  try {
    const result = validateJsonBytes(kind, bytes);
    self.postMessage({ id, bytes: result }, { transfer: [result] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
