// Entry of `.exports/build-site.mjs` (see build-site.ts).
import { main } from './build-site.js';

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
