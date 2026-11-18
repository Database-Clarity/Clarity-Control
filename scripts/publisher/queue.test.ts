import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Harness, fixturesDir, git } from '../../packages/export/test/site/harness.js';

it('FIFO mixed pinned inputs preserve newest outputs through human/engine pushes, receipts, old arrivals, and retry', async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'false');
  const h = new Harness();
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    const input = JSON.parse(readFileSync(join(fixturesDir, 'legacy-input.json'), 'utf8'));
    await h.seed({ input: JSON.stringify(input) });
    const inputs: string[] = [];
    const receipts: { commit: string; path: string }[] = [];
    const change = (revision: number, receipt = false, engine = false) => {
      const next = structuredClone(input);
      const perk = Object.values(next.perks).find(
        (entry) => (entry as { editor?: { en?: { main: string } } }).editor?.en?.main,
      ) as { editor: { en: { main: string } } };
      perk.editor.en.main += `\nRevision ${revision}`;
      const files: Record<string, string> = { 'liveDescriptions.json': JSON.stringify(next) };
      if (engine) {
        files['.exports/PIN'] = 'd'.repeat(40) + '\n';
        files['.exports/engine.mjs'] =
          h.show(h.head('converter'), '.exports/engine.mjs')!.toString() + '\n// engine install\n';
      }
      let path = '';
      if (receipt) {
        const opId = '01K95H0000000000000000000' + revision;
        path = `.publish/receipts/2025-11/${opId}.json`;
        files[path] = JSON.stringify({
          opId,
          now: revision,
          generatorSha: h.generatorSha,
          sourceCommit: h.head('editor-data'),
        });
      }
      const commit = h.commit('converter', files);
      inputs.push(commit);
      if (receipt) receipts.push({ commit, path });
      return commit;
    };
    change(1, true); // Publisher P1.
    change(2); // Human push queued ahead of P1.
    change(3, false, true); // Engine install queued ahead of the older publisher.
    change(4, true);
    change(5, true); // Two publisher receipts back to back.
    const run = (commit: string) => {
      const converter = h.checkout('converter');
      git(converter, ['checkout', '--detach', commit]);
      return h.legacyRun({
        checkouts: { converter, live: h.checkout('live'), pins: h.checkout('export-pins') },
      });
    };
    let newest = -1;
    const check = () => {
      const pin = JSON.parse(h.show(h.head('export-pins'), 'pins/latest.json')!.toString());
      expect(pin.converterSha).toBe(inputs[newest]);
      expect(pin.inputSha256).toBe(hash(h.show(inputs[newest], 'liveDescriptions.json')!));
      for (const { commit, path } of receipts) {
        expect(git(h.lcd, ['rev-parse', `${commit}:${path}`])).toMatch(/^[a-f0-9]{40}$/);
      }
      return pin;
    };
    // FIFO is waiting order, not event age. Old receipts may arrive after newer work.
    for (const index of [1, 0, 2, 0, 3]) {
      const result = run(inputs[index]);
      expect(result.status, result.stderr).toBe(0);
      if (index < newest) expect(result.stdout).toContain('stale: nothing deployed');
      newest = Math.max(newest, index);
      check();
    }
    // Failure after pending pin, before the live CAS, followed by retry of the same pinned input.
    const hook = join(h.lcd, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old next ref; do\n  if [ "$ref" = "refs/heads/live" ]; then exit 1; fi\ndone\n',
    );
    chmodSync(hook, 0o755);
    const failed = run(inputs[4]);
    expect(failed.status).not.toBe(0);
    check();
    unlinkSync(hook);
    expect(run(inputs[4]).status).toBe(0);
    newest = 4;
    const pin = check();
    const liveBefore = h.head('live');
    expect(run(inputs[0]).stdout).toContain('stale: nothing deployed');
    expect(h.head('live')).toBe(liveBefore);
    check();
    const engine = await import(pathToFileURL(resolve(h.exports, 'engine.mjs')).href);
    const expected = engine.buildLegacy(
      JSON.parse(h.show(inputs[4], 'liveDescriptions.json')!.toString()),
      'dim',
      { identical: pin.hashes },
    );
    expect(h.show(h.head('live'), 'descriptions/dim.json')).toEqual(Buffer.from(expected));
    // GitHub's 101st pending cancellation is a failed G8 audit, not a silent lost input.
    const audit = join(h.root, 'runs.json');
    writeFileSync(
      audit,
      JSON.stringify({
        total_count: 102,
        workflow_runs: Array.from({ length: 102 }, (_, id) => ({
          id,
          conclusion: id === 101 ? 'cancelled' : null,
        })),
      }),
    );
    const cancelled = h.node(resolve('scripts/publisher/template/.publisher/check-queue.mjs'), [
      audit,
    ]);
    expect(cancelled.status).toBe(1);
    expect(cancelled.stderr).toContain('G8: cancelled output runs');
    expect(cancelled.stderr).toContain('101');
  } finally {
    h.cleanup();
    vi.unstubAllEnvs();
  }
}, 300_000);
