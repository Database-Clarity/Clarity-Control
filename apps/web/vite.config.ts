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
      // Keep the public entry's ESM graph independent: otherwise shared editor imports
      // retain unused schema constructors and the data router on public cold loads.
      name: 'isolate-public-report',
      apply: 'build',
      enforce: 'pre',
      transform(code, id) {
        if (
          !id.endsWith('?report-public') ||
          !/\/(packages\/core|apps\/web\/src\/services)\//.test(id.replaceAll('\\', '/'))
        )
          return;
        // Schema declarations have no observable effects until parsed. The editor
        // uses more of them; public bundles can drop constructors they never read.
        return code.replace(/(\b(?:const|let)\s+\w+\s*=\s*)(z\s*\.)/g, '$1/* @__PURE__ */ $2');
      },
      async resolveId(source, importer, options) {
        const suffix = '?report-public';
        if (!source.endsWith(suffix) && !importer?.endsWith(suffix)) return null;
        const from = importer?.replace(suffix, '');
        const renderer: Record<string, string> = {
          react: 'preact/compat',
          'react-dom': 'preact/compat',
          'react-dom/client': 'preact/compat/client',
          'react/jsx-runtime': 'preact/jsx-runtime',
          'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
        };
        if (renderer[source])
          return this.resolve(renderer[source], from, { ...options, skipSelf: true });
        const resolved = await this.resolve(source.replace(suffix, ''), from, {
          ...options,
          skipSelf: true,
        });
        if (!resolved || resolved.external || resolved.id.includes('?')) return resolved;
        const id = resolved.id.replaceAll('\\', '/');
        if (
          /\.[cm]?[jt]sx?$/.test(id) &&
          (/\/(apps\/web|packages\/core)\//.test(id) ||
            /\/node_modules\/(zod|react-router|react-router-dom|zustand)\//.test(id))
        )
          return { ...resolved, id: resolved.id + suffix };
        return resolved;
      },
    },
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
              chunk.facadeModuleId?.replaceAll('\\', '/').endsWith('/apps/web/src/main.tsx')
            ) {
              chunk.dynamicImports.forEach(visit);
            }
          }
          const urls = [...files].filter((file) => !html.includes(`href="./${file}"`));
          return [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `if (!/^#\\/report(?:[/?]|$)/.test(location.hash)) { for (const href of ${JSON.stringify(urls)}) { const link = document.createElement('link'); link.rel = 'modulepreload'; link.crossOrigin = ''; link.href = './' + href; document.head.append(link); } }`,
              injectTo: 'head' as const,
            },
          ];
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
