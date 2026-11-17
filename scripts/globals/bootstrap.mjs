// Offline only. plan creates an immutable proposal and backup; apply stages locally.
// apply/verify/restore require the plan SHA printed by plan. Never commits or pushes.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
try {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('./bootstrap.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { main } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  );
  await main(
    process.argv.slice(2),
    createHash('sha256').update(compiled.outputFiles[0].text).digest('hex'),
  );
} catch (error) {
  process.stderr.write(`Globals bootstrap refused: ${error.message}\n`);
  process.exitCode = 1;
}
