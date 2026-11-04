import publisherConfig from '../../config/publisher.json';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { reviewGuidancePlugin } from './reviewGuidanceMiddleware';
import { manifestFactsSchema } from './src/features/compendium/manifestFactsSchema';

export default defineConfig({
  plugins: [
    {
      name: 'validate-manifest-facts',
      buildStart() {
        const path = fileURLToPath(
          new URL('./src/features/compendium/manifest-facts.json', import.meta.url),
        );
        this.addWatchFile(path);
        manifestFactsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      },
    },
    react(),
    reviewGuidancePlugin(fileURLToPath(new URL('./review-guidance.json', import.meta.url))),
  ],
  define: {
    'import.meta.env.VITE_PUBLISHER_ENABLED': JSON.stringify(publisherConfig.enabled ? '1' : '0'),
  },
  base: './',
  // JSON.parse is substantially cheaper than compiling a multi-megabyte object literal.
  json: { stringify: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith('/manifest-facts.json')) return 'manifest-facts';
        },
      },
    },
  },
});
