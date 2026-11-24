# E2 operator runbook (P1-E1; writes enabled to converter-v2-test by PUB-ENABLE)

Run from the Description-editor checkout. No command here enables the publisher transport.
The single release switch is `config/publisher.json` (`enabled: true` checked in since PUB-ENABLE,
2026-11-14; LIVE_BRANCH stays converter-v2-test, so writes reach only that branch).
Vite defines VITE_PUBLISHER_ENABLED from that file, overriding shell/.env values; the Worker
imports the same file. Rebuild both artifacts from the SAME commit when changing it.
OFF preserves legacy /push-live and rejects POST /publish and /publish/kick even with a key.
ON returns 410 for every /push-live request, before authentication/upstream I/O.
Status/key remain read-only. P1-F adds the remote publishing transport, gated OFF. Enablement
still requires its independent safety/integration reviews and every gate below. Installed
dry-run workflows continue to simulate publication; changing the shared switch alone cannot publish.
The built runtime bakes config/publisher.json in at build time (the enable build's publisher.mjs
carries `enabled: true`). Enabling remote writes therefore needed a new template build and PIN from a
commit whose config says `enabled: true`, reviewed and CI-gated on that exact tree, then a
re-install of .publisher with `publishWritesEnabled: true` (`install.mjs --apply-local`).
With an older (enabled: false) build, `publishWritesEnabled: true` in the installed
config throws "Remote publishing disabled by config", and a hand-edited publisher.mjs fails its PIN.

Signing-key rotation must wait until pending requests and landed receipts have been recorded.
Recovery verifies requester credits against the trusted public key and fingerprint; a mismatch
halts recording. Retain the original trusted verification key for operator recovery, and never
rewrite a published commit or infer author credits from an unsigned receipt field.

## Install dry-run pipeline (root operator in E2)

Before installing an `arrowSymbol` PIN, satisfy the [Arrow symbol rollout precondition](README.md#arrow-symbol-rollout-precondition).
For a `numberTokens` PIN, also satisfy the [Number tokens rollout precondition](README.md#number-tokens-rollout-precondition).
Install an `exoticTags`-capable publisher before saving Exotic text or starting the gated Yellow-to-Exotic data rewrite; older PINs refuse it.
While `config/inactive.json` is non-empty, never roll back to a PIN without `inactiveMoves`.
For `schedulePreparationV1`, install the verified runtime and serialized workflow first,
reconcile legacy in-flight operations, and retain every installed capability floor. Only then
deploy compatible Worker and web builds and enable asynchronous admission with owner approval.
Never downgrade the preparation reader or claim fence while requests or claims remain.
Before accepting globals schedules, scheduled saves, or Retry, install a verified
`scheduledGlobalsV1` runtime retaining `globalsRelease`, `globalsExportsV1`, `schedulePreparationV1`, and every
existing capability. Root performs this installation in the authorized globals go-live
sequence. Pinned global edits and owed reviews move affected batches to Needs attention;
return them to draft and schedule again after review. Never rewrite their signed source
to adopt newer definitions. Both claim and atomic LIVE/RECORD recheck the closure.
For the scheduled save-race fix, deploy the compatible Worker and web builds before
installing the publisher PIN. They read both preparation failures and refused claims in
Needs attention. Keep both readers in place while refused-claim records exist. Older
open tabs retain the batch in the list and need a reload to read the new detail.
The Action prepares intents before Globals, bundles, and drains publication in the same run.
Blacksmith is the default runner; workflow_dispatch with ubuntu-latest is the manual fallback
when a job never starts. Both share editor-data-pipeline concurrency with cancellation disabled.
No installation, activation, or external data write is authorized by generating this template.

Template source PIN: `8a1ab5125f59404f2a117e96a9a5c77e03aed07e`.
Expected publisher.mjs SHA-256: `ef8f29047688e5bd3df27ad0739e6a65750150d3564cdeee4f09e8790a4289d7`.
Verify both against `.publisher/PIN` before installation; this v2 runtime includes the current
set-bonus, name-relink, category, alias-group, and optional export-partner schemas. Rebuild from
the pinned source in a clean checkout to reproduce the digest. A future source change requires
rebuilding and re-pinning.
The runtime also includes the current Link only guards and the set-bonus publication hold.
Its bundle pushes carry the report catalogs forward; the pipeline's report-items jobs refresh them.

1. Record current editor-data, editor-data-bundle and converter-v2-test SHAs. Verify Actions
   contents:write permission; forward-only/no-delete data/live rules; candidate ref permissions.
   Confirm no tooling force-pushes data/live. Drain or cancel ALL existing bundle.yml jobs;
   its old concurrency group can otherwise overwrite the new bundle. Pause incoming saves
   during this small installation window. Do not touch production converter/live or Pages.
2. Prepare a clean local editor-data checkout of Database-Clarity/Live-Clarity-Database.
   Copy config.example.json to an operator-owned public config file. Fill trusted HTTPS
   /publish/key URL, independently verified SPKI fingerprint, PIN.sourceSha, exact generator
   SHA and nonempty facts/aliases from that SHA. No signing/session/App private key in config.
   A public key must be available before simulation; if unavailable, installation still bundles
   but fails simulation with a visible artifact. Do not claim a successful rehearsal in that case.
3. `node scripts/publisher/install.mjs <checkout> <public-config.json> --plan`
4. `node scripts/publisher/install.mjs <checkout> <public-config.json> --apply-local`
   This also writes `.publisher/installed.json` (version, configOid, and generatorSha).
   Commit it with the exact `.publisher/config.json` bytes from that same installer run;
   missing or stale metadata makes globals reads refuse until the installation is complete.
   Inspect the diff and lint both workflows. In one editor-data commit retire bundle.yml and
   install `.github/workflows/pipeline.yml`, `.github/workflows/publisher-run.yml`, and the pinned
   `.publisher/` files with their public config and installed.json. Run the installer with
   `--verify` and the same config and target on that clean HEAD before the operator pushes.
5. Observe pipeline artifact result.json: dryRun:true, publishWritesEnabled:false, no errors.
   Check the run's report-items and report-items-push jobs are green and editor-data-bundle
   still holds report-items.json and report-items.worker.json, both with the bundle's
   sourceCommit (a cold Worker /reports and the web Reports page load).
   Check real bundle sourceCommit is current data head and publishQueue contains only opId,
   requester numeric id/login, hash list and createdAt (invalid requests expose opId/invalid only).
   Confirm data/live/candidate refs have no simulated commits; requests remain pending by design.
   Request/kick/save starts catch-up; no unattended cron in P1. Resume saves.

Rollback installation by draining publisher, output, and report jobs, then reverting the one
installation commit on editor-data via a normal forward push. The revert restores the prior
workflow files, runtime, PIN, and public config together. Retain requests, receipts, logs, and dry-run
artifacts.
Rollback future switch release: first stop/drain any future write-capable publisher, confirm no
unrecorded candidate/receipt, restore enabled:false and rebuild/release BOTH Worker and web from
one commit before allowing legacy writes. Never overlap two writers. No rollback is executed here.

## Production handoff rehearsal and G5 installation order

Preparation does not authorize production installation or publishing. Keep native/set-bonus
holds closed until the independently reviewed S1-compatible release candidate is approved.

1. From a private pristine editor-data clone, retain its HEAD, installed config/PIN, and refs.
   Copy the public config, retain its generator/facts/aliases/key identities, and set publisherSha
   to this template's source PIN. For test, keep liveBranch=converter-v2-test. For production,
   explicitly set liveBranch=converter. Run `install.mjs <clone> <config> --plan --target=test`
   and `install.mjs <clone> <production-config> --plan --target=production`, saving both patches.
   Stdout is only the exact committed-HEAD patch; the status line goes to stderr. Baselines
   come from Git blobs, independent of working-tree line endings. Template attributes force LF.
   Neither plan contacts GitHub or changes the clone. Check both patches in a pristine LF checkout with
   `git -c core.autocrlf=false apply --check <patch>`; use --apply-local only in a disposable
   clone to compare the planned bytes. Never run --pipeline-dry-run as an offline rehearsal:
   that mode deliberately pushes the real editor-data-bundle branch.
2. Save the current converter build-outputs.yml blob identity. Review the exact prepared
   `template/build-outputs.patch` against that baseline; any drift requires a refreshed diff
   and review. The new publication input is optional, so existing legacy:boolean callers work.
   It checks out the publication's immutable converter, RECORD, and generator commits and
   verifies receipt/input/engine identities before either output build. Each receipt freezes
   the verifier SHA-256; the privileged job's inline loader checks that digest before execution.
   Ordinary non-publisher descendants need no publisher handoff. Test publication never calls it.
   Site configs are read from current editor-data under the data-site deployment slot; the
   immutable RECORD proof is checked out separately. Retry retains newer config saves.
   Test installs call the local publisher workflow without downstream outputs. The explicit
   production plan appends production-job.yml to publisher-run.yml after the G5 workflow input
   upgrade is installed. The calling pipeline job holds the publish slot through both outputs.
   The exact reusable patch intentionally converts the baseline workflow's CRLF bytes to LF;
   retain the original blob alongside the semantic review diff so this conversion is explicit.
3. G4/G5 operator gate, not execution here: pause intake, drain running pipeline jobs, and
   reconcile pending requests, candidate refs, receipts, RECORDs, and export pins. Verify
   effective no-rewind/no-delete protection on converter and live; the existing publisher
   ruleset does not cover those branches. Install the approved compatible .exports engine
   before any hold release. Retain backups and every installed capability floor.
4. Only after the owner's exact G5 approval, install the reviewed reusable-workflow diff on
   converter, then the reviewed production plan on editor-data, while intake stays paused.
   The editor-data installer never installs build-outputs.yml on converter. Coordinate Worker
   LIVE_BRANCH=converter with installed .publisher config, verify target/PIN agreement, and
   admit only the reviewed production request. A test-signed request is never retargeted.
   BEFORE the real installation, obtain owner approval for a hosted dry validation on a
   non-production branch: a no-op workflow_dispatch exercising queue:max (without publishing
   or deployment), or GitHub's own workflow validation. All callers adopt the reviewed
   reusable workflow only after the old groups are drained. This step is not authorized here.
   actionlint 1.7.12 rejects concurrency.queue. Production plans instead parse YAML and enforce
   queue:max/cancel-in-progress:false for both groups, refusing unsupported syntax or policy.
5. Inspect result.json and the `publish` step's production_push/publication outputs. They bind
   the confirmed converter commit, receipt and request blobs, source/RECORD commits, input
   OID/SHA-256, engine PIN/SHA-256, generator SHA, and publisher source/runtime digest.
   Rejected or unresolved publication exposes no production handoff. A failed downstream
   legacy build can be retried from the durable receipt/RECORD until its export pin matches.
   For a failed site job, use Actions **Re-run failed jobs**, retaining the original handoff.
   Confirm all seven outputs, versions, export pin, and site against that immutable identity.

Both legacy-outputs and data-site use GitHub's FIFO waiting queue, capped at 100 pending jobs.
Human-push legacy callers pin the converter event SHA; publisher callers pin the receipt commit.
The existing forward-only live CAS and stale-input guard prevent an older input from replacing
newer output. An old legacy/site arrival logs a green no-op. No custom queue, catch-up dispatch,
or latest-head substitution is used. FIFO is waiting order, not source-commit order.

G8 queue audit, after each controlled publish batch and whenever cancellation is reported:
fetch every page of Actions runs for the complete reviewed time window (GitHub API
`actions/runs?created=...&per_page=100`, `gh api --paginate --slurp`), save the JSON, and run
`node .publisher/check-queue.mjs <runs.json>`. Incomplete capture or any cancelled run exits
nonzero with a G8 signal. Check the cancelled run's jobs. When the `pipeline` job succeeded
and only `report-items` and `report-items-push` were cancelled or skipped, a newer report build
superseded them and the publish needs no retry. For any other cancellation, reconcile the
original event SHA, publication artifact, and current output pin before retrying the exact input.

Stop/recover (G8): stop intake and drain/reconcile before restoring approved artifacts.
Keep receipts, request credits, and append-only export pins. Forward-revert data and workflow
changes; never reset, force-push, overwrite held refs, or downgrade capability floors. A target
rollback requires a deliberate `--target=test` plan, matching Worker/config changes, and
reconciliation of every production-signed request first. Reverting config alone cannot undo
already-published consumer output; restore it with an owner-approved forward publication.
When rolling back workflow support, restore the test editor-data plan FIRST (it has no new
callee inputs), reconcile/drain its output jobs, and only then revert the converter workflow.

## CPU preview gate (synthetic, no repository I/O)

Pinned project Wrangler 4.153.0; use local `node node_modules/wrangler/bin/wrangler.js`.
Check `whoami` and account scope first. The ONLY remote mutation allowed here is `versions upload`
to the dedicated `clarity-publisher-cpu-preview` Worker. Never use deploy, versions deploy, secret
put or production config. If the account requires initial deployment to provision this dedicated
Worker or enable version previews, stop and let the root operator resolve that gate separately.

The harness bundles the real Worker entry/auth/GitHub/publish implementations. esbuild injects an
allowlisted synthetic fetch binding into all modules, with no network fallback. Keys are freshly
generated throwaway fixtures in ignored cpu/dist; there are no real tokens, bindings or routes.
GitHub GraphQL/REST serialization/parsing, HMAC verification, RS256 JWT, Ed25519 signing and base64
run normally. Mock writes return synthetic responses only. It measures CPU, not network latency.
Installation token currently lives per GitHub instance/request: both temperatures include App JWT.

For EACH mode publish/pending/terminal/kick and size 1/100/2511:

```
node scripts/publisher/cpu/prepare.mjs publish 2511
node node_modules/wrangler/bin/wrangler.js versions upload --config scripts/publisher/cpu/dist/wrangler.json --preview-alias cpu-p1e1 --message cpu-p1e1
node node_modules/wrangler/bin/wrangler.js tail clarity-publisher-cpu-preview --config scripts/publisher/cpu/dist/wrangler.json --version-id <uploaded-uuid> --format json
node scripts/publisher/cpu/sample.mjs <immutable-version-preview-url> cold <uploaded-uuid>
node scripts/publisher/cpu/sample.mjs <immutable-version-preview-url> warm <uploaded-uuid>
```

Run tail in a second terminal and retain its output. Repeat upload+cold+warm 20 times per case,
keeping only one complete 20-request warm set for each case. Cold means the FIRST invocation on
a fresh version/isolate; warm excludes its priming request. Do not request the version URL before
the cold sample. Pending status avoids request body downloads; terminal status includes an envelope
and maximum per-hash outcomes. Phase 3 cron 0/3 claims is held and MUST be measured before P3.

Workers tail may omit cpuTime. Use Workers Logs for this dedicated preview version with full
observability sampling, export request CPU time in milliseconds, and join to console cpuSample,
isolate and invocation fields. Never substitute wallTime/duration. Normalize one JSONL record per
request to `{sampleId,cpuTime,isolate,invocation}`; retain the original Logs export and samples.jsonl
as evidence. Missing CPU telemetry, dropped samples or cold/warm isolate mismatches block the gate.
`node scripts/publisher/cpu/analyze.mjs <normalized-log.jsonl>` requires exactly 20 samples per
case/temperature and p99 <7 ms, with distinct cold isolates and one isolate per retained warm set.
On failure lower the hash cap/client split or compact validation/body; repeat all affected cases.
No CPU pass is claimed by E1; root runs the remote gate in E2. Local preview dry-run build only:
`node node_modules/wrangler/bin/wrangler.js versions upload --config scripts/publisher/cpu/dist/wrangler.json --dry-run`.

### Active-deployment gate collector (supersedes the manual loop above for E2-A)

`CLOUDFLARE_ACCOUNT_ID=<id> node scripts/publisher/cpu/gate.mjs <evidence-dir> [mode:size,...]`
Per attempt: own directory with fresh bundle/keys/token (`CPU_OUT`), one `deploy` of the
synthetic config to `clarity-publisher-cpu-preview` only, one tail with its own debug directory
confirmed ready before the first request, 400 ms pacing. Every response carries the bundle's
`X-CPU-Build` stamp: responses from the previous deployment while the new one propagates are
recorded as `stale` and never counted (run 6's HTTP 401 was such a stale isolate with the old
session secret). Workers Logs (`cf o11y telemetry query`, needs the cf CLI's observability scope;
Wrangler's OAuth token lacks it) is authoritative and polled until every sent sampleId has cpuTime,
outcome, isolate and invocation; tail is a cross-check only (it drops events). Cold must be
invocation 1, 20 warm on invocation > 1; incomplete cases retry once. Delete the Worker afterwards.

## First actual output parity (after a future write-capable release)

`npm run build:publisher`
`node scripts/publisher/dist/parity.mjs <scratch-data-repo> <exact-live-commit> <receipt-path> <public-config.json> <converter-adapters.mjs> <output-directory>`

Fetch source/parent objects read-only into a scratch clone first. The script reads the receipt's
frozen tooltip blobs/time/requester, verifies digests and generator pin, runs exportLegacy +
stampUploads + merge, and requires byte-identical liveDescriptions. Following parity-1103.md,
provide TWO pinned converter adapters (deployed and held); adapter exports `adapters` array of
`{sha,convert(input)->{filename:serializedString}}` and `production` map of seven original consumer
files. Controls on the unmodified parent input must reproduce all seven files byte-for-byte.
Adapters must be prepared in scratch, without running production conversion/deployment workflows.
Compare saved outputs and classify every change using parity-1103's text/alias/frame fold,
secondary/stats, catalog facts and upload-stamp classes (B1/B2/B3/R1 remain owner gates).
parity.json reports controls and byte parity; it does NOT automatically approve consumer diffs.
Review missing/new entries, translations, globals, ordering, and compendium/archive leakage.
No unexplained difference is acceptable; retain all inputs, pins and output files in the E2 report.

## Scheduled batches (P4; after phase-B step 4, with the enable build)

The P4 runtime changes publisher.mjs, so its template is re-pinned at the P4 merge (after
phase-B step 4) with a PIN declaring `["elementTags", "sandboxPointers", "scheduledBatches"]` (the enable build
adds `"markupBraces"`)
(the source and digest at the top of this runbook). It reaches editor-data only with the enable
build (step 8) or a later re-install (owner gate G3). Before
re-installing: no batch may be `publishing`, and no claimed due.json entry may exist. While the
installed PIN lacks the capability, the Worker refuses to schedule, so no batch request can be
waiting for a runtime that cannot drain it. First real batch (G4, converter-v2-test): after its
RECORD, run parity.mjs on its receipt. Its tooltip blobs are the composed live snapshots, which
RECORD commits to editor-data under live/tooltips. Then check batch.json `result` (landedAt and
its source, recordedAt, and exportNow), that schedule/due.json is empty, and that there are no
unexpected schedule/activation-conflicts files. Rollback: as for the publisher, but first
unschedule every scheduled batch and let every `publishing` one finish. An older runtime REJECTS
any pending batch request (it fails the push schema) without returning the batch to draft,
which would leave batch.json naming a finished opId. A claimed batch with no receipt resumes only
on a runtime with the capability.
