import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Seconds each slow file took in the single-job CI run 43398475513 (the
// set-bonus-real parts: their share of set-bonus.test.ts); every other
// file counts as 1 s. Vitest's own --shard splits by path hash and
// put four of these in one shard, so CI shards bin-pack by these weights.
const SLOW_FILES: Record<string, number> = {
  'packages/export/test/set-bonus-real-1.test.ts': 60,
  'packages/export/test/set-bonus-real-2.test.ts': 60,
  'packages/export/test/set-bonus-real-3.test.ts': 60,
  'packages/export/test/set-bonus-real-4.test.ts': 30,
  'packages/export/test/site/build.test.ts': 121,
  'apps/web/src/features/exports/previewCore.test.ts': 116,
  'packages/export/test/element-tags.test.ts': 112,
  'scripts/publisher/publisher.test.ts': 104,
  'packages/export/test/parity-editor-data.test.ts': 85,
  'packages/export/test/parity-live.test.ts': 76,
  'apps/worker/test/reports.test.ts': 18,
  'scripts/publisher/remote.test.ts': 17,
  'packages/export/test/v1.test.ts': 13,
  'apps/web/src/features/history/HistoryEntry.test.tsx': 11,
};

class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weighted = files.map((spec) => {
      const path = relative(root, spec.moduleId).replaceAll('\\', '/');
      return { spec, path, weight: SLOW_FILES[path] ?? 1 };
    });
    // Heaviest first, then by path, into the lightest shard: every shard
    // job computes the same assignment from the same file list.
    weighted.sort(
      (a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    const loads = new Array<number>(shard.count).fill(0);
    const mine: TestSpecification[] = [];
    for (const file of weighted) {
      const target = loads.indexOf(Math.min(...loads));
      loads[target] += file.weight;
      if (target === shard.index - 1) mine.push(file.spec);
    }
    return mine;
  }
}

export default defineConfig({
  test: {
    // CI runners are slow under a full parallel run; cold dynamic imports exceed 5s.
    testTimeout: 20_000,
    sequence: { sequencer: WeightedShardSequencer },
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.{ts,tsx}',
      'scripts/compendium/*.test.mjs',
      'scripts/weapon-section-inventory/*.test.mjs',
      'scripts/lost-text/*.test.mjs',
      'scripts/publisher/*.test.ts',
      'scripts/mult-write/*.test.ts',
      'scripts/enhanced-arrow/*.test.ts',
      'scripts/variant-forms/*.test.mjs',
      'scripts/compendium/coverage/compare.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'legacy/**'],
  },
});
