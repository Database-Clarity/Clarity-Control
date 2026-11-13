import assert from 'node:assert/strict';

// Browser-harness checks that guard a real product defect which is reported but not fixed yet.
// Such a check never passes by being loosened: it still runs, and a failure prints one
// "KNOWN DEFECT <id>" line instead of stopping the harness, so the rest of the harness keeps
// guarding. STRICT_KNOWN_DEFECTS=1 turns every such check back into a hard assertion (run that
// way once the named fix merges, then drop the marker). The summary says which still fail.

const strict = process.env.STRICT_KNOWN_DEFECTS === '1';
const failures = new Map();
const checked = new Set();

/**
 * `ok` false records (or, in strict mode, throws) the defect `id`; `detail` names the case.
 * `fixedBy` names the task or report that fixes it.
 */
export function knownDefect(id, ok, detail, fixedBy) {
  checked.add(id);
  if (ok) return;
  if (strict) assert.fail(`KNOWN DEFECT ${id} (${fixedBy}): ${detail}`);
  const list = failures.get(id) ?? [];
  if (!list.length) console.log(`KNOWN DEFECT ${id} (${fixedBy}): ${detail}`);
  list.push(detail);
  failures.set(id, list);
}

/** Prints one line per known defect the harness checked: still failing, or now passing. */
export function knownDefectSummary() {
  for (const id of checked) {
    const list = failures.get(id);
    console.log(
      list
        ? `KNOWN DEFECT ${id}: still fails (${list.length} checks)`
        : `KNOWN DEFECT ${id}: every check passed; drop the marker`,
    );
  }
}

/**
 * Status bar items cut at the window edge at phone width: the bar keeps its long labels down to a
 * 24rem (384px) container, so at 390 an issue count, Raw (docked markup bar), and a character
 * warning push the last item past the edge, where the bar clips it. `cut` lists those items.
 */
export function statusBarClip(label, cut) {
  knownDefect(
    'status-bar-390-clip',
    !cut.length,
    `${label}: status bar items cut at the window edge ${JSON.stringify(cut)}`,
    'reported in .agents/reports/stale-harnesses.md',
  );
}

/**
 * Holistic review 2026-11-13 finding 3: with the Reports tab, the Compendium pane header's
 * contents outgrow its box when a linked cell changed, so the cell scale ("− 100% +") is pushed
 * out of view and the title squeezes. Expected to pass once "Holistic UI fixes"
 * (agents/holistic-ui-fixes) merges. `cut` lists the header items that are cut.
 */
export function compendiumHeader(label, cut) {
  knownDefect(
    'compendium-header-overflow',
    !cut.length,
    `${label}: Compendium header items cut ${JSON.stringify(cut)}`,
    'expected to pass after Holistic UI fixes, agents/holistic-ui-fixes',
  );
}
