# E2 operator runbook (P1-E1; writes remain disabled)

Run from the Description-editor checkout. No command here enables the publisher transport.
The single release switch is `config/publisher.json` (`enabled: false` checked in).
Vite defines VITE_PUBLISHER_ENABLED from that file, overriding shell/.env values; the Worker
imports the same file. Rebuild both artifacts from the SAME commit when changing it.
OFF preserves legacy /push-live and rejects POST /publish and /publish/kick even with a key.
ON returns 410 for every /push-live request, before authentication/upstream I/O.
Status/key remain read-only. P1-F adds the remote publishing transport, gated OFF. Enablement
still requires its independent safety/integration reviews and every gate below. Installed
dry-run workflows continue to simulate publication; changing the shared switch alone cannot publish.

## Install dry-run pipeline (root operator in E2)

Template source PIN: `cac0b1e95824a3ab3b0c93c3bc13c808dcb76277`.
Expected publisher.mjs SHA-256: `e2fe19cd0c5376167a16b3e83d2eb4fc875931abcf3cca5986425234bb6a3dec`.
Verify both against `.publisher/PIN` before installation; this v2 runtime includes the current
set-bonus, name-relink, category and alias-group schemas. Rebuild from the pinned source in a
clean checkout to reproduce the digest. A future source change requires rebuilding and re-pinning.

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
   This only changes local files: retire bundle.yml, add pipeline.yml and .publisher together.
   Inspect `git -C <checkout> diff`, run actionlint on the installed workflow and inspect PIN.
   The operator then commits and normally pushes ONLY editor-data after review. Neither script
   commits nor pushes. No workflow files are installed on production branches or this editor repo.
5. Observe pipeline artifact result.json: dryRun:true, publishWritesEnabled:false, no errors.
   Check real bundle sourceCommit is current data head and publishQueue contains only opId,
   requester numeric id/login, hash list and createdAt (invalid requests expose opId/invalid only).
   Confirm data/live/candidate refs have no simulated commits; requests remain pending by design.
   Request/kick/save starts catch-up; no unattended cron in P1. Resume saves.

Rollback installation: drain/cancel pipeline runs, revert the installation commit on editor-data
with a normal forward push (never reset/force-push), then restore bundle.yml service. Do not run
both workflows concurrently. Keep requests/receipts/logs intact. Bundle sourceCommit can reference
installation history safely. Record resulting heads and retain dry-run artifacts.
Rollback future switch release: first stop/drain any future write-capable publisher, confirm no
unrecorded candidate/receipt, restore enabled:false and rebuild/release BOTH Worker and web from
one commit before allowing legacy writes. Never overlap two writers. No rollback is executed here.

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
