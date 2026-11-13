import assert from 'node:assert/strict';

// Browser-harness checks that guard a real product defect which is reported but not fixed yet.
// They are ordinary hard assertions: the harness fails while the defect is there. Only an
// explicit ALLOW_KNOWN_DEFECTS=1 run records each failure as one "KNOWN DEFECT <id>" line and
// continues, to show the rest of the harness still passes; such a run is not a pass.

/** True only in an ALLOW_KNOWN_DEFECTS=1 run. */
export const allowKnownDefects = process.env.ALLOW_KNOWN_DEFECTS === '1';
const failures = new Map();
const checked = new Set();

/**
 * `ok` false fails the defect `id` (in an ALLOW_KNOWN_DEFECTS=1 run: records it); `detail` names
 * the case.
 * `fixedBy` names the task or report that fixes it.
 */
export function knownDefect(id, ok, detail, fixedBy) {
  checked.add(id);
  if (ok) return;
  if (!allowKnownDefects) assert.fail(`KNOWN DEFECT ${id} (${fixedBy}): ${detail}`);
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
        ? `KNOWN DEFECT ${id}: still fails (${list.length} checks; ALLOW_KNOWN_DEFECTS run, not a pass)`
        : `KNOWN DEFECT ${id}: every check passed; drop the marker`,
    );
  }
}

/**
 * A `pageerror` handler that pushes each page error's message onto `errors`. A superseded
 * Compendium matching session rejects with "Compendium inputs changed." and nothing handles it,
 * so on the production build it surfaces as an uncaught page error whenever the data changes
 * during matching (every shell fixture load). That message stays a page error (the harness's own
 * error check fails); only an ALLOW_KNOWN_DEFECTS=1 run records it as a known defect instead.
 */
export function collectPageErrors(errors) {
  return (error) => {
    if (allowKnownDefects && error.message === 'Compendium inputs changed.')
      knownDefect(
        'compendium-cancel-unhandled',
        false,
        'uncaught "Compendium inputs changed." page error',
        'reported in .agents/reports/stale-harnesses.md',
      );
    else errors.push(error.message);
  };
}
