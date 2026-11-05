import { computeDiagnostics, type DiagnosticInput } from './diagnosticRequest';

self.onmessage = (event: MessageEvent<{ id: number; input: DiagnosticInput }>) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, result: computeDiagnostics(input) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
