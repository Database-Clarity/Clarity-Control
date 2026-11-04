import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolve('apps/web/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
process.env.VITE_API_URL = 'https://api.qa.test';
await build({
  root: 'apps/web',
  configFile: 'apps/web/vite.config.ts',
  configLoader: 'runner',
  build: {
    outDir: '../../.agents/legacy-history/qa-dist',
    emptyOutDir: true,
    rollupOptions: { input: 'apps/web/test/legacy-history.html' },
  },
});
