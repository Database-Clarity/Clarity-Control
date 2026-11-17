import { useAuthStore } from '../../stores/auth';

/**
 * Scheduled changes (spec .agents/reports/scheduled-changes/spec.md, I6). A build-time switch read
 * from config/scheduled.json by vite.config.ts; OFF (the production default, and whenever that file
 * is absent) means no batch UI, no batch route call, and no batch draft storage read or write.
 */
export function scheduledEnabled(): boolean {
  return import.meta.env.VITE_SCHEDULED_ENABLED === '1';
}

/**
 * Batch saves and schedules through the Actions preparer (sched-actions-contract.md). OFF unless
 * the authenticated Worker reports preparation enabled in /me:
 * while OFF every write keeps the synchronous flow and sends no requestId. Batches that are
 * already preparing or need attention render either way.
 */
export function preparationEnabled(): boolean {
  return scheduledEnabled() && useAuthStore.getState().user?.schedulePreparation === true;
}
