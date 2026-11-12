// G-PREVIEW in a real browser (exports-browser.mjs): the app's preview Web Worker loads the fixture
// site's snapshot (status -> sha256 -> blob: engine) and reports the sha256 of each whole-file
// build. The script compares them with build-site's builds of the same files in Node.
import { newStyleFile, styles } from '@clarity/export';
import type { ExportFile } from '@clarity/export/config';
import { PreviewClient } from '../src/features/exports/previewClient';
import { loadStatus } from '../src/features/exports/site';
import { randomFiles } from '../src/features/exports/testConfigs';

declare global {
  interface Window {
    previewCheck?:
      { results: { file: ExportFile; sha256: string; ms: number }[] } | { error: string };
  }
}

async function run() {
  const status = await loadStatus();
  const client = new PreviewClient(status);
  await client.ready;
  const catalog = (await (
    await fetch(`${import.meta.env.VITE_DATA_SITE_URL}/_build/${status.buildId}/catalog.json`)
  ).json()) as { categories: { id: string }[] };
  const categories = catalog.categories.map((category) => category.id);
  const files: ExportFile[] = [
    ...styles.flatMap((style) =>
      (['lines', 'text'] as const).map((shape) =>
        newStyleFile(
          `${style}-${shape}`,
          style,
          { ...newStyleFile('x1', style).data, categories, sandboxPerks: categories },
          shape,
        ),
      ),
    ),
    { id: 'v2', formatVersion: 1, preset: 'clarityV2' },
    ...randomFiles(20, categories),
  ];
  const results = [];
  for (const file of files) {
    const started = performance.now();
    const { sha256 } = await client.fileHash(file);
    results.push({ file, sha256, ms: performance.now() - started });
  }
  client.dispose();
  window.previewCheck = { results };
}
run().catch((error: unknown) => {
  window.previewCheck = { error: error instanceof Error ? error.message : String(error) };
});
