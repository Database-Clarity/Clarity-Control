import publisherConfig from '../../config/publisher.json';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { reviewGuidancePlugin } from './reviewGuidanceMiddleware';
import { manifestFactsSchema } from './src/features/compendium/manifestFactsSchema';

const exportsZod = '?exports-zod';
const exportsCode = /\/apps\/web\/src\/features\/exports\/|\/packages\/export\//;

export default defineConfig({
  plugins: [
    {
      name: 'preload-startup-stages',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          const bundle = context.bundle;
          if (!bundle) return html;
          // Fetch the shared bootstrap graph together, while main.tsx still
          // evaluates its stages separately. Otherwise each yield also adds a
          // network round trip before the workspace can start loading data.
          // These modules are required on every route; page chunks stay lazy.
          const files = new Set<string>();
          const visit = (file: string) => {
            if (files.has(file)) return;
            const chunk = bundle[file];
            if (chunk?.type !== 'chunk') return;
            files.add(file);
            chunk.imports.forEach(visit);
          };
          for (const chunk of Object.values(bundle)) {
            if (
              chunk.type === 'chunk' &&
              chunk.isEntry &&
              chunk.facadeModuleId?.replaceAll('\\', '/').endsWith('/apps/web/index.html')
            ) {
              chunk.dynamicImports.forEach(visit);
            }
          }
          return [...files]
            .filter((file) => !html.includes(`href="./${file}"`))
            .map((file) => ({
              tag: 'link',
              attrs: { rel: 'modulepreload', crossorigin: '', href: `./${file}` },
              injectTo: 'head' as const,
            }));
        },
      },
    },
    {
      // The export config schema uses zod parts the editor does not (discriminated unions,
      // tuples). Rollup tree-shakes per export, so sharing one zod would move those parts into
      // the editor's startup chunk. The Exports routes get their own zod copy instead: schemas
      // never cross between the two (exports code only exchanges plain data with the editor).
      name: 'isolate-exports-zod',
      apply: 'build',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        if (!importer) return null;
        const from = importer.replaceAll('\\', '/');
        const tagged = from.endsWith(exportsZod);
        const zodImport = source === 'zod' || source.startsWith('zod/');
        if (!tagged && !(zodImport && exportsCode.test(from))) return null;
        const base = tagged ? importer.slice(0, -exportsZod.length) : importer;
        const resolved = await this.resolve(source, base, { ...options, skipSelf: true });
        if (!resolved || resolved.external || resolved.id.includes('?')) return resolved;
        return { ...resolved, id: resolved.id + exportsZod };
      },
    },
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
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith('/manifest-facts.json')) return 'manifest-facts';
        },
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js' } },
  },
});
