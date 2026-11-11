// Static checks of the prepared (not installed) workflow files: groups, triggers, environment
// scoping, explicit refs, capped permissions, and no config value in an expression or shell line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const reusable = read('workflows/converter/.github/workflows/build-outputs.yml');
const main = read('workflows/converter/.github/workflows/main.yml');
const exportsYml = read('workflows/editor-data/.github/workflows/exports.yml');
const pipeline = read('../../scripts/publisher/template/.github/workflows/pipeline.yml');

/** The text of one job (from `  <name>:` to the next job or the end). */
const job = (name: string) => {
  const start = reusable.indexOf(`\n  ${name}:\n`);
  const next = reusable.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? reusable.slice(start) : reusable.slice(start, start + 1 + next);
};

describe('prepared workflows', () => {
  it('build-outputs.yml is reusable only, with separate never-cancelled groups', () => {
    expect(reusable).toMatch(/^on:\n {2}workflow_call:\n/m);
    for (const file of [reusable, main, exportsYml]) {
      const triggers = file.slice(file.indexOf('\non:\n'), file.indexOf('\njobs:\n'));
      expect(triggers).not.toMatch(/workflow_dispatch|pull_request|schedule|workflow_run/);
    }
    expect(job('legacy')).toMatch(
      /concurrency:\n {6}group: legacy-outputs\n {6}cancel-in-progress: false/,
    );
    expect(job('site')).toMatch(
      /concurrency:\n {6}group: data-site\n {6}cancel-in-progress: false/,
    );
    expect(job('legacy')).not.toMatch(/data-site|environment:/);
  });

  it('only the site job names the deploy environment, and the token reaches only locate and deploy', () => {
    expect(job('site')).toMatch(/\n {4}environment: data-site-deploy\n/);
    expect(reusable.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(2);
    const build = job('site').slice(
      job('site').indexOf('- name: Build the site'),
      job('site').indexOf('- name: Deploy'),
    );
    expect(build).not.toMatch(/secrets\.|CLOUDFLARE/);
    expect(job('site')).toMatch(/permissions:\n {6}contents: read/);
    expect(job('legacy')).not.toMatch(/permissions:/);
  });

  it('every checkout names its repository and ref', () => {
    const checkouts = reusable.split('uses: actions/checkout@').slice(1);
    expect(checkouts).toHaveLength(9);
    for (const checkout of checkouts) {
      const block = checkout.split('\n      - ')[0]!;
      expect(block).toMatch(
        /repository: Database-Clarity\/(Live-Clarity-Database|Description-data-generator)\n/,
      );
      expect(block).toMatch(/ref: (converter|live|export-pins|editor-data|v2)\n/);
    }
    // Only the legacy job keeps push credentials (live and export-pins).
    expect(job('site').match(/persist-credentials: false/g)).toHaveLength(5);
  });

  it('no expression in a run line, and the only expressions are run ids, secrets, vars, and step outputs', () => {
    const runLines = reusable.split('\n').filter((line) => /^\s+(run: |--|node |npx )/.test(line));
    for (const line of runLines) expect(line).not.toContain('${{');
    const expressions = [...reusable.matchAll(/\$\{\{([^}]*)\}\}/g)].map((match) =>
      match[1]!.trim(),
    );
    for (const expression of expressions)
      expect(expression).toMatch(
        /^(github\.run_id|github\.run_attempt|secrets\.CLOUDFLARE_API_TOKEN|vars\.(CLOUDFLARE_ACCOUNT_ID|PAGES_PROJECT)|!cancelled\(\))$/,
      );
    expect(reusable).toMatch(/if: steps\.build\.outputs\.deploy == 'true'/);
  });

  it('callers pin the reusable workflow on converter and cap permissions', () => {
    const uses =
      'uses: Database-Clarity/Live-Clarity-Database/.github/workflows/build-outputs.yml@converter';
    expect(main).toContain(uses);
    expect(exportsYml).toContain(uses);
    expect(main).toMatch(/^permissions: \{\}$/m);
    expect(exportsYml).toMatch(/^permissions: \{\}$/m);
    expect(main).toMatch(/permissions:\n {6}contents: write/);
    expect(main).toMatch(/legacy: true/);
    expect(exportsYml).toMatch(/permissions:\n {6}contents: read/);
    expect(exportsYml).toMatch(/legacy: false/);
    expect(exportsYml).toMatch(/branches:\n {6}- editor-data\n {4}paths:\n {6}- 'exports\/\*\*'/);
    expect(main).toMatch(/branches:\n {6}- converter\n/);
    for (const file of [main, exportsYml]) expect(file).toContain('secrets: inherit');
  });

  it('the publish pipeline ignores config-only pushes', () => {
    expect(pipeline).toMatch(
      /branches: \[editor-data\]\n {4}# .*\n {4}paths-ignore: \['exports\/\*\*'\]/,
    );
  });
});
