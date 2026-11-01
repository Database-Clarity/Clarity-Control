import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { reviewGuidancePlugin } from './reviewGuidanceMiddleware';

export default defineConfig({
  plugins: [
    react(),
    reviewGuidancePlugin(fileURLToPath(new URL('./review-guidance.json', import.meta.url))),
  ],
  base: './',
});
