import { build } from 'vite';
const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const configFile = new URL('./migrate-vite.config.ts', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
process.env.MIGRATE_TEST_OLD_ORIGIN = 'http://127.0.0.1:43171';
process.env.MIGRATE_TEST_NEW_ORIGIN = 'http://localhost:43172';
for (const mode of ['new', 'old']) {
  process.env.VITE_MOVED_MODE = mode === 'old' ? '1' : '0';
  await build({
    root,
    configFile,
    configLoader: 'runner',
    build: { outDir: `dist-migrate-${mode}` },
  });
}
