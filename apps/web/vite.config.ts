import publisherConfig from '../../config/publisher.json';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { reviewGuidancePlugin } from './reviewGuidanceMiddleware';

export default defineConfig({
  worker: { format: 'es' },
  plugins: [
    react(),
    reviewGuidancePlugin(fileURLToPath(new URL('./review-guidance.json', import.meta.url))),
  ],
  define: {
    'import.meta.env.VITE_PUBLISHER_ENABLED': JSON.stringify(publisherConfig.enabled ? '1' : '0'),
  },
  base: './',
});
