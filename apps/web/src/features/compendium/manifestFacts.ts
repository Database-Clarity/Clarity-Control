import { manifestFactsSchema, type ManifestFacts } from './manifestFactsSchema';

export { manifestFactsSchema, type ManifestFacts } from './manifestFactsSchema';

// This checked-in asset is validated by Vite before a build is emitted. Its module is
// shared by every consumer; do not repeatedly validate and clone it on page startup.
const bundledFacts = (await import('./manifest-facts.json')).default as ManifestFacts;
// Let the browser paint and dispatch input between the asset evaluation and its
// consumers' module initialization. Synchronous getters are ready before they run.
await new Promise<void>((resolve) => setTimeout(resolve, 0));
export function loadManifestFacts(input?: unknown): ManifestFacts {
  return input === undefined ? bundledFacts : manifestFactsSchema.parse(input);
}
