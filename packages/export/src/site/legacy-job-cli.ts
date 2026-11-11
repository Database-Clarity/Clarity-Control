// Entry of `.exports/legacy-job.mjs` (see legacy-job.ts).
import { main } from './legacy-job.js';

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
