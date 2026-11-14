import { computeDiagnostics, type DiagnosticInput } from './diagnosticRequest';
import { createTermsHandler, type TermsRequest } from '../terms/termsRequest';

const terms = createTermsHandler();

self.onmessage = (
  event: MessageEvent<{ id: number; input?: DiagnosticInput; terms?: TermsRequest }>,
) => {
  const { id, input } = event.data;
  try {
    const result = event.data.terms ? terms(event.data.terms) : computeDiagnostics(input!);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
