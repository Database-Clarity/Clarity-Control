import facts from './manifest-facts.json';
import { manifestFactsSchema, type ManifestFacts } from './manifestFactsSchema';

export { manifestFactsSchema, type ManifestFacts } from './manifestFactsSchema';

// This checked-in asset is validated by Vite before a build is emitted. Its module is
// shared by every consumer; do not repeatedly validate and clone it on page startup.
const bundledFacts = facts as ManifestFacts;
export function loadManifestFacts(input?: unknown): ManifestFacts {
  return input === undefined ? bundledFacts : manifestFactsSchema.parse(input);
}
