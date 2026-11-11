import type { Context, Env } from '../src/types.js';
import worker from '../src/index.js';
import type { ReportsDatabase, ReportStatement } from '../src/reports.js';

/** Wall-clock proxy only: excludes awaited D1 spans, not a Workers CPU measurement. */
export async function reportBudget(request: Request, env: Env, context: Context) {
  let dbMs = 0,
    dbCalls = 0;
  const measure = async <T>(run: () => Promise<T>) => {
    dbCalls++;
    const start = performance.now();
    try {
      return await run();
    } finally {
      dbMs += performance.now() - start;
    }
  };
  // Proxied D1 statement methods require the original statement object in batch().
  const originals = new WeakMap<ReportStatement, ReportStatement>();
  const database = (db: ReportsDatabase): ReportsDatabase => {
    const make = (original: ReportStatement): ReportStatement => {
      const result: ReportStatement = {
        bind(...args) {
          return make(original.bind(...args));
        },
        first<T>() {
          return measure(() => original.first<T>());
        },
        all<T>() {
          return measure(() => original.all<T>());
        },
        run() {
          return measure(() => original.run());
        },
      };
      originals.set(result, original);
      return result;
    };
    return {
      prepare(query) {
        return make(db.prepare(query));
      },
      batch(statements) {
        return measure(() => db.batch(statements.map((s) => originals.get(s) ?? s)));
      },
      exec(query) {
        return measure(() => db.exec(query));
      },
    };
  };
  const scoped = {
    ...env,
    REPORTS_DB: env.REPORTS_DB && database(env.REPORTS_DB),
    REPORTS_FILES_DB: env.REPORTS_FILES_DB && database(env.REPORTS_FILES_DB),
  };
  const start = performance.now();
  const response = await worker.fetch(request, scoped, context);
  const wallMs = performance.now() - start;
  return { response, wallMs, dbMs, handlerMs: Math.max(0, wallMs - dbMs), dbCalls };
}
