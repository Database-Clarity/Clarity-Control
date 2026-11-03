/**
 * Publisher editor UX (IndexedDB-persisted publish operations against POST /publish). OFF by default:
 * the current /push-live path stays in force until the owner enables writes (design step E). The flag
 * is a build-time switch, so a deployed bundle without it behaves exactly as before.
 */
export function publisherEnabled(): boolean {
  return import.meta.env.VITE_PUBLISHER_ENABLED === '1';
}
