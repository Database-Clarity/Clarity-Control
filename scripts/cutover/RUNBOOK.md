# Cutover rehearsal (S4)

This package prepares an offline inventory and exercises the existing moved-page
build on two loopback origins. It grants no production approval. The authoritative
export contract is `.agents/reports/export-builder/spec.md`, sections 9–12, and
the execution order is `.agents/reports/cutover-plan.md`, gates G2–G7 (coordination
files in the owner's checkout). Final evidence waits for the combined S1–S3 and
Number tokens candidate. No production workflow is executed by these scripts.

## Candidate inventory

From this checkout, run `node scripts/cutover/rehearse.mjs` and save stdout outside
the repository as the single candidate manifest. It performs only a local git read.
`sourceCommit` identifies the inventory source, **not** the approved cutover tree.
The manifest is deliberately `PREPARATION_ONLY`; nulls and PENDING entries are
blockers, never passes. This is an inventory template, not an approval validator.

The seven embedded schema-1 configs each have exactly one frozen legacy preset
file, `descriptions`, at format version 1. `proposedConfigSha256` hashes UTF-8
`JSON.stringify(config, null, 2) + '\n'`. These are proposed create payloads, with
no server-assigned uid. After an authorized create, capture the exact stored bytes,
uid, and `installedConfigSha256`; do not confuse their hash with the proposal hash.
No project is created by generating this manifest. There is no M1 clarityV2 project.

| Project   | Preset / exact old filename | New URL                                                   |
| --------- | --------------------------- | --------------------------------------------------------- |
| clarity   | clarity / clarity.json      | https://data.d2clarity.com/clarity/v1/descriptions.json   |
| dim       | dim / dim.json              | https://data.d2clarity.com/dim/v1/descriptions.json       |
| foundry   | foundry / foundry.json      | https://data.d2clarity.com/foundry/v1/descriptions.json   |
| lightgg   | lightGG / lightGG.json      | https://data.d2clarity.com/lightgg/v1/descriptions.json   |
| crayon    | crayon / crayon.json        | https://data.d2clarity.com/crayon/v1/descriptions.json    |
| braytech  | braytech / braytech.json    | https://data.d2clarity.com/braytech/v1/descriptions.json  |
| vaultzero | vaultZero / vaultZero.json  | https://data.d2clarity.com/vaultzero/v1/descriptions.json |

For each exact old filename above, retain **both** existing URL forms:
`https://database-clarity.github.io/Live-Clarity-Database/descriptions/<filename>`
and `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/live/descriptions/<filename>`.
The generated manifest expands all fourteen URLs. Preserve `versions.json`, too.
These files keep updating at their current URLs; new URLs are additional copies.

Before calling an inventory final, set `candidateCommit` to the full reviewed SHA,
and fill all identity fields from immutable receipts and actual installed artifacts:
converter, editor-data, live, export-pins, generator, input, identical list, catalog,
manifest version, engine PIN and bytes, publisher PIN, Worker version, and web
artifact. Include installed package versions, active workflow revisions, target,
rulesets, backups, held refs, and receipt IDs in the referenced G1 evidence.
For every evidence entry, record candidate SHA, evidence path, SHA-256 of its bytes,
command/run ID, outcome, and timestamp. Historical reports are context only.
Changing any input or engine invalidates evidence depending on it. Hash each actual
old file and new copy against the same pin's `liveCommit`, including carried and
frozen outcomes; never compare an arbitrary latest URL to an earlier receipt.

## Gate evidence checklist

| Evidence             | Required observation on the exact candidate                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-PARITY             | Eight presets against held adapters and real input; seven byte comparisons at the pin; exact-case filenames, versions, set-bonus, and Prismatic deltas classified.                                             |
| G-REFS               | Cross-category associations, excluded canonicals, nested imports, and decoded v1 indices all resolve after filtering.                                                                                          |
| G-PREVIEW            | Snapshot hashes verified; edited styles and 20 seeded configs equal Actions bytes; unchanged seven read pinned live bytes, including carried/frozen files; clarityV2 first build, and status change covered.   |
| G-BUILD              | Dry-run isolation, bootstrap, invalid/oversized new and existing files, carry hashes, reverse-order runs, pin reconciliation, cancellation/failure, vocabulary freeze, and config/publish interleaving.        |
| G-SIZE               | Real alias facts, raw/gzip/brotli and served bytes, parse cost, and reference decoder round-trip on go-live input.                                                                                             |
| G-COST / free-limits | 240 typical URLs <3 min, worst-case budget/rotation, frozen downloads, and cold/warm Worker save CPU/subrequests. Attach `reports/hosted-cpu.md` from the relevant evidence bundle; absent here means PENDING. |
| triggers             | Config-only save starts site, never legacy/publisher; publish receipt with successful converter push reaches legacy and site through the reusable workflow; test target cannot start production outputs.       |
| environment-refusal  | Actual allowed converter/editor-data callers obtain the deployment environment, and an unauthorized ref is refused without exposing secrets. Source text alone is insufficient.                                |

G-PARITY and production workflow behavior belong to their VITAL owners. These
scripts neither emulate those workflows nor turn proposed checklist items into
passing evidence. If this slice needs tests executing production workflow behavior,
stop and ask root to promote it to VITAL before implementing them.

Free-limit evidence must record the actual account plan and observed direct-upload
build counting, monthly headroom, 20,000-file deployment cap, 25 MiB file cap,
Worker CPU/subrequests, storage, and deployment count (including zero-deployment
bootstrap). The historical spec's Pages 500-build/month figure is not a fresh
verification. Verify current limits at execution. If direct uploads consume the
cap, the spec's Workers static-assets fallback requires separate owner approval,
credentials, header/atomicity checks, and bootstrap evidence; do not reduce cadence.

## Local moved-page rehearsal

Check dependencies resolve in this checkout before building. All commands below
run from its root. Use the existing test-only origin build; do not change the
production protocol or deployed origin constants. Run CPU-heavy commands through
the shared heavy wrapper, never a full local suite:

```powershell
node -e "require.resolve('vite'); require.resolve('playwright-core')"
python -I D:/GitHub/Description-editor/.agents/t3/suite-lock/heavy.py node apps/web/test/migrate-build.mjs
$env:CUTOVER_MOVED_LOCAL = '1'
python -I D:/GitHub/Description-editor/.agents/t3/suite-lock/heavy.py node --test scripts/cutover/rehearse.test.mjs
Remove-Item Env:CUTOVER_MOVED_LOCAL
```

The opt-in test serves the existing `dist-migrate-old` and `dist-migrate-new`
artifacts with loopback-only Vite preview servers on strict ports 43171 and 43172.
It closes its servers and headless browser even on failure, uses a fresh browser
context, and blocks every request outside the two local origins. Occupied ports
fail rather than attaching to somebody else's server. `CUTOVER_BROWSER` can name
a local Chromium executable; otherwise the test tries installed Chrome/Edge, then
Playwright's installed Chromium. No credentials or signed-in profile are used.
Without `CUTOVER_MOVED_LOCAL=1`, Node runs only the inventory check and marks the
browser check skipped. A skipped browser check is not rehearsal evidence.

State checklist: partial-readable collection → review → cancel (no writes) → retry
→ merge (copies retained at source) → duplicate transfer (no duplicate writes) →
clear confirmation → Keep them → confirm after source edit (edit and unreadable
bucket retained) → conflicting import (destination unchanged, unmerged download
offered) → export fallback → file import → explicit merge. A real opener at the
wrong origin sends a snapshot and is ignored. Storage assertions check both sides.
This is functional rehearsal, with no performance or hosted claims.

Build a separate ordinary production web artifact with `VITE_MOVED_MODE` unset,
through heavy.py, and retain the build log and artifact hash. Inspect its emitted
entry graph to prove movedEntry is absent; the test-origin receiver build is not
this evidence. Record old-site artifact, receiver artifact, default artifact, exact
headers, sign-in evidence, and rollback artifact in `moved`. Local injected-origin
artifacts must never be deployed. For each artifact retain a sorted relative-path
SHA-256 inventory and hash that inventory; do not hash only index.html.

## Owner-gated execution and recovery

1. G1: re-read actual installed identities, held refs, heads, and receipts; settle
   Number tokens and scheduling, drain publisher work, and confirm no competing
   writer. Root checks whether G2's one corrected test re-push was already consumed.
2. G2: only the separately approved isolated publish supplies deployed parity and
   recovery evidence. This runbook does not authorize using that allowance.
3. G3: obtain explicit approval for project/partner writes, analytics/WAF/DNS/token
   changes, workflow updates, and installs. Verify existing clarity-data,
   data-site-deploy, export-pins, and exports.yml rather than recreating them.
   Extended permissions-schema support must land before any partners write.
4. G4–G5: owner approves exact converter/npm/engine/PIN/workflow set, then matching
   production target and hold release. Install the compatible engine first; verify
   target agreement, receipt, seven copies, and pins before admitting requests.
5. G6: first-upload confident-link persistence follows the approved S3 manifest and
   ordering contract. S4 neither runs it nor writes a baseline.
6. G7 LAST: owner approves the real github.io moved artifact only after new-domain
   sign-in, publish, and draft receiving pass. Capture actual CORS, cache, CSP, and
   opener/COOP headers on both origins, popup handshake, cancel/retry, duplicate,
   conflicts, edited clear, and file fallback using disposable drafts. Check that
   sign-in returns to control.d2clarity.com, without leaking drafts or credentials.
   Hosted checks and a real cross-origin transfer remain separate from local QA.

Analytics/WAF plan (G3, PENDING): add the approved data host entry to Analytics
config, verify visibility only on the owner's dashboard, and verify cache and
response headers. Capture the owner-approved WAF Skip rule, its scope, logging,
ordering, and a logged request demonstrating collection; never add a blanket
bypass or change rules from this rehearsal. Use the cf CLI for Cloudflare unless
the relevant project contains a Wrangler configuration file.

Announcement date: **PENDING OWNER**. Grace end date: **PENDING OWNER, at least
three calendar months after the single announced date**. Do not start a grace
clock by running this package. Notify all seven partners with old/new URL pairs,
hash evidence, update-check guidance, and the shared date. Keep old URLs updating
during grace, then best effort; freeze only the breaking file in place. Capture
the post-exception vocabulary baseline at grace end as specified, with approval.

G8: unexplained bytes, failed workflows, missing Prismatic, target/PIN mismatch,
or lost links/drafts stop intake and require reconciliation. Keep the approved
old editor artifact, new receiver artifact, Worker configuration/version, engine,
publisher PIN, receipts, input backups, and data rollback manifest before execution.
Restore approved artifacts/configuration, and forward-revert data if authorized.
Never force-push, overwrite held refs, shorten grace, clear drafts automatically,
or roll below capabilities needed by already-written number-token, inactive, or
arrow data. Record recovery evidence before resuming intake.
