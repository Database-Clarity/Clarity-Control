/**
 * Scheduled changes (spec .agents/reports/scheduled-changes/spec.md, I6). A build-time switch read
 * from config/scheduled.json by vite.config.ts; OFF (the production default, and whenever that file
 * is absent) means no batch UI, no batch route call, and no batch draft storage read or write.
 */
export function scheduledEnabled(): boolean {
  return import.meta.env.VITE_SCHEDULED_ENABLED === '1';
}
