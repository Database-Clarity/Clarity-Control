# Publisher

## Cutover handoff plans (G4/G5 preparation only)

`node scripts/publisher/install.mjs <checkout> <config.json> --plan --target=test`
prints the exact committed-tree installation patch on stdout (status goes to stderr).
Its baseline is Git HEAD, so LF and CRLF working checkouts produce the same patch.
Test is the default, and its config must name
`converter-v2-test`. Production requires `--target=production` and a config naming `converter`.
Unknown plans, disagreeing config, implicit rollback from production to the default test plan,
and capability downgrades are refused. `--apply-local` writes the same planned bytes, without
committing or pushing. Review/apply the patch against an LF checkout of that HEAD; use
--apply-local to prepare files in a Windows checkout. Template attributes require LF bytes.

The serialized pipeline exposes `production_push` and `publication` from its `publish` step.
One receipt/RECORD identity path handles publication and recovery. `result.json` retains the
latest confirmed pair, its receipt and request blob OIDs,
source/record/converter commits, input OID and SHA-256, engine PIN and SHA-256, generator SHA,
publisher source SHA, runtime digest, and receipt-bound verifier digest. Jobs check that
digest before executing the verifier with write/deploy privileges. The test branch has no installed consumer engine;
its absent engine identity is explicitly null, and it never starts legacy or site jobs.
Production refuses a missing engine. The final catch-up must succeed before job outputs appear.
The test plan contains no downstream reusable-workflow call. Only the explicit production
plan appends `template/production-job.yml`, so test installs remain independent of the
G5-only reusable-workflow input upgrade.

The downstream caller passes this immutable publication to `build-outputs.yml@converter`.
The prepared replacement is `template/.github/workflows/build-outputs.yml`, and its exact
production-baseline diff is `template/build-outputs.patch`. Neither is installed by the
editor-data installer: G5 separately installs the reusable workflow on converter and verifies
its baseline before enabling the production plan. Existing callers that supply only `legacy`
retain legacy:boolean compatibility. Human-push legacy jobs pin the converter event SHA;
publisher jobs pin the confirmed receipt commit. Both output groups use queue:max with
cancellation disabled. Each build uses its exact input; the existing forward-only live CAS
and stale-deploy guard make older arrivals green no-ops. An older site's receipt also becomes
a green no-op when a verified newer deployment exists. No latest-head substitution occurs.
`verify-publication.mjs` installs with .publisher.
The site reads current `exports/` after acquiring its shared deployment slot; the pinned
RECORD proof uses a separate checkout. Publication and failed-job retries therefore preserve
newer config-only deployments while retaining immutable data, engine, and generator inputs.

Retry reconciles receipts, RECORDs, and export pins. A crash after RECORD but before job output,
or a failed legacy build, re-emits the same handoff until the output pin confirms its input,
engine, and generator. An already-built input, including a receipt-only no-op, skips the call.
An ordinary human/engine descendant needs no publication handoff and is also a green no-op.
After a site failure, use Actions **Re-run failed jobs** to retain the original successful
pipeline outputs and immutable handoff; do not substitute a latest-head build.
Queue capacity is 100 pending runs per group. G8's complete-window check-queue.mjs audit
fails visibly for cancelled runs (including overflow); operators reconcile and retry their
exact pinned inputs. No custom queue or catch-up dispatcher is installed.

Production plans parse YAML and enforce the supported queue policy before producing a diff.
actionlint 1.7.12 rejects the new queue key; it cannot certify this workflow. The G5 runbook
requires owner-gated hosted dry validation before installation. The exact reusable patch
explicitly converts the baseline's CRLF to LF; its full-file line-ending delta is intentional.

G4/G5 remain owner gates: no installation, workflow activation, Worker target switch, native
or set-bonus hold release, production refresh, deploy, held-ref change, or main merge is granted
by preparing these files. Retain every installed capability floor, including numberTokens,
inactiveMoves, and arrowSymbol. Confirm effective converter/live protections before G5; the
observed publisher ruleset covers editor-data and converter-v2-test only.

`npm run build:publisher` builds the plain Node 24 CLI and integrity PIN in `dist/`.
`node scripts/publisher/dist/publisher.mjs --dry-run <local repository> <config.json> <artifact directory>`
copies the input into a disposable bare simulator, runs the serialized pipeline, and emits a Git bundle
of would-be commits plus result.json. It never changes the source or contacts a remote.

Config supplies repo, dataBranch, liveBranch, publicKey (PEM from the independently trusted Worker key
endpoint), keyFingerprint (SHA-256 of SPKI DER, pinned independently), publisherSha, generatorSha,
facts, aliases, and runUrl. Facts and aliases must come from the pinned generator commit.
The standalone dry-run does not fetch keys or provide a write enable switch.
The `schedulePreparationV1` capability verifies Worker-signed save and schedule intents,
their exact submitted bytes, and immutable member-tree identities. Preparation runs before
the globals drain, bundle, and publisher in the same serialized pipeline. One CAS commits
all accepted members, request results, ready fences, due entries, events, and the derived
index. Unprepared batches cannot be claimed. A rejected translator save restores only the
exact accepted schedule authorized by its signed owner policy; other failures need attention
and remove the due entry. Infrastructure Retry uses the existing authenticated pipeline kick.
The `scheduledGlobalsV1` capability permits asynchronous schedules with Globals metadata.
The `globalsExportsV1` capability adds per-entry exports and the ordered hash-1 projection.
The original signed schedule source pins the globals used by the batch's composed roots,
including nested imports and conservative title preparation, through the real resolver.
Preparation rechecks ready batches before their due time; changed pins or owed global reviews
require attention and a fresh schedule, and claim rechecks the same contract. Batch roots,
approved dependencies, Globals state, activation, and markers join one atomic LIVE/RECORD
transaction. The Worker refuses globals schedules, scheduled saves, and Retry when the
installed runtime lacks this capability, globalsRelease, or schedulePreparationV1.
The prepared `globalsRelease` capability uses `globals/layout.json` and an exact
`globals/live/<destination>.json` baseline. One serialized Action drain materializes reviews
and name proofs; failed sync retains causes and rows, and refreshes only occupied-name proofs
so authors can repair a definition. Global releases require atomic Git updates of LIVE and
RECORD, and never export unrelated saved definitions. Storage bootstrap, workflow installation,
and activation remain separate owner gates; this template update performs none of them.
The later publish transport must enforce forward-only LIVE/data refs and serialized execution;
candidate ref swaps/deletes require exact old OIDs. Unresolved pushes wait 30 seconds between
attempts (five waits maximum); successful writes record immediately. Tests inject a no-wait backoff.
The local simulator deliberately fails closed on non-100644 modes; a real transport must preserve
all existing tree modes before it can be enabled. Queue ordering and receipt lookup use first-parent
Git addition history rather than enumerating historical trees.

Receipts include frozen export inputs so rebasing never revalidates content or changes the timestamp.
Terminal logs contain recordCommit:null because embedding a commit's own hash is circular; consumers
resolve the recording commit from first-parent history of the log path. Rejected/stale operations have
no liveCommit. Bundle updates use CAS and source ancestry, including on failed/empty drains.

Maintainer moves in `config/inactive.json` require PIN capability `inactiveMoves`.
Saving a move changes editor classification immediately; outputs change only when its canonical
review row publishes. A publish applies that row's decision and its alias decisions, while other
staged moves remain unpublished. Move-out markers (`inactive: false`) retain re-add intent.
The receipt's source commit freezes these decisions for retries, rebases, and parity checks.
Canonical removal also removes its live alias stubs. Every retained live importer and association
must remain valid: removal is rejected before a candidate or live write when a consumer still
reads removed text. Edit/publish that importer first, or select its edit/removal together with the
target. Selections containing a removal stay in one dependency group within the existing Worker
caps, so a previously saved importer edit and its target removal cannot split across chunks.

Request creation is head-bound CAS. A caller must consult `classifyPublishIntent` at each fresh head;
creation timestamps are checked only for a new operation. No coalescing is implemented; scheduled
batches (`kind: 'batch'`) are described in "Scheduled batches (P4)" below.

## Worker request API (P1-B, writes disabled until enable-time secret)

`POST /publish` accepts only `{opId, hashes, expected}` (core schema, 3,000 hashes,
300 KiB streamed body cap). Targets and numeric requester ID come from the Worker.
`PUBLISH_SIGNING_KEY` is an Ed25519 PKCS8 PEM Worker secret; it is deliberately
absent from configuration. Tests generate ephemeral keys. Do not install the real
key until the enable gate; `/push-live` remains available during this phase.
`GET /publish/key` is public, costs zero subrequests, and returns
`{algorithm, publicKey, fingerprint}` (SPKI PEM, SHA-256 of SPKI DER). Pin that
fingerprint in the eventual job. No private material is returned or logged.

Creation reads permissions, request and tombstone through one GraphQL Commit,
then creates an inline tree on its root tree, a sole-parent commit, and updates
the ref with `force:false`. Branch no-force/no-delete rules are an enable gate.
Every create error reconciles at a fresh head. Two create attempts plus the final
read cost at most **10** subrequests (typically 5), including the installation
token. This conservative retry bound leaves the mandatory reconciliation inside
the design's <=13 budget. A 503 must be retried with the **same** opId and body.
Existing requests/results bypass the ±24-hour creation window.

`GET /publish/status?opId=<id>` accepts exactly one ID and returns only
`{operations:[{opId,status}]}`. Status is unknown, pending, done, unchanged, stale,
rejected or failed. It costs 2 subrequests including authentication to GitHub.
`POST /publish/kick {opId}` checks the same head for an uncompleted pending
request, then creates a uniquely named kick file using the Contents API (3
subrequests). A completion racing a kick makes that kick harmless. Both status
and kick require a current numeric-ID maintainer/editor permission. Metadata
that GraphQL cannot return as complete text fails closed without REST fallbacks.
Request files are queried by object ID only for status/kick; kick queries log
existence by object ID too. Status deliberately accepts only one ID (within the
design maximum of 20) because a terminal log embeds the full signed request and
up to 3,000 per-hash outcomes. Callers must poll IDs separately. The CPU gate must
include one maximum-size terminal log as well as a pending 3,000-hash request;
also assert that 20-ID status calls are rejected before upstream I/O. Do not raise
the status cap without measuring the maximum log size times the proposed cap.
All endpoints retain the shared 48-subrequest hard cap. CPU measurement and
workflow registration/enablement belong to subsequent phases.

## Pipeline template (P1-C)

`template/.github/workflows/pipeline.yml` and `template/.publisher/` are installation
artifacts, not active workflows in this editor repository. No installation is performed here.
Pushes changing only `exports/**`, `glossary/**`, `snippets/**`, or `config/marks.json`
do not trigger the editor-data pipeline.
The plain Node 24 runtime includes packages/core and has no runtime npm dependencies.
`npm run build:publisher -- --template` rebuilds both runtime and PIN from the committed
source HEAD. Commit source first, then build/commit the generated files so the source pin
identifies the exact implementation. Do not edit generated publisher.mjs by hand.

Current template source: `cfd7f12f1facf2d50baf4078d4c80c0ee4f6d998` (v2).
Runtime SHA-256: `2051844efa75e978785e6dbd7d3e30919fc997ab9941b080b377e6b4fd82a0f0`.

The `exoticTags` capability declares lowering of `<exotic … />` to the compatible
`yellow` consumer style, including comment-split keywords. While publishing is enabled,
save, publish, and scheduled-proposal validation refuse Exotic text until the publisher
installed in the data branch declares this capability. Install the updated template
before saving Exotic text or running the separate gated data rewrite. The deprecated
`yellow` authoring alias retains compatibility. Format v1 uses `exotic` for its
style and configuration key; the seven legacy outputs still use `yellow`.
Exotic is literal-only authoring syntax. Variable-assembled tag names keep the base
resolver's unknown-tag behavior, with a warning; assembled `yellow` remains supported.
This includes set-bonus pieces, name relinks, armor-set-bonus categories and alias-group schemas.
Permissions accept the optional export `partners` map while retaining strict validation.
This rebuild also includes the current Link only guards and the set-bonus publication hold.
It lowers element-tagged text (`<solar Scorch />` to `<solar/>Scorch`) in exportLegacy, rejects
an export that still holds one, and its PIN declares `capabilities: ["elementTags"]`, which the
Worker's /save and /publish require while the publisher is on (element-tags.test.ts checks the build).
Prismatic joined the element tags later: this build also declares `prismaticTags`, which the Worker
additionally requires for `<prismatic Text />` (an older `elementTags` build would drop its text).
The current core barrel also includes unused report-schema initialization in this runtime.
This rebuild also carries the previous bundle's other files (the report catalogs) forward.
bundle.json `globals` holds the globals catalogue at the bundle's sourceCommit: every entry in
catalogue page order plus the public sync header (the Worker's publicGlobalSync), or null when
the catalogue files are malformed. The editor reads its finder lists from it; the Worker serves
only the opened entry, its reviews, and writes. Install this build before deploying that editor.
It merges maintainer sandbox picks (config/sandbox-pointers.json, core mergeSandboxPointers with
the config's generator `sandboxConflicts`) into the aliases it digests and exports, carries the
picks in bundle.json, and its PIN declares `sandboxPointers`, which the Worker's
PUT /sandbox-pointers requires while the publisher is on. Fill `sandboxConflicts` in config.json
from the same pinned generator commit as `aliases`.
It lowers delimited variables and the arrow symbol (`#{d}` to `#d`, `<enhanced/>` to `#e`, core
braces.ts) in exportLegacy, rejects an export that still holds `#{` or `<enhanced/>`
(unloweredEntry), and its PIN declares `markupBraces`, which the Worker's /save and /publish
require for them while the publisher is on (build.mjs refuses the PIN without both markers).
This is the enable build (PUB-ENABLE): config/publisher.json says `enabled: true`.
Its publishableHash uses the same consumer-markup rules and English number map as the Worker,
so number identity changes are publish-relevant, while spelling-only markup edits keep their hash.
The `numberTokens` capability resolves translation tokens from each tooltip's live and frozen
English values before lowering consumer markup. Invalid maps and unknown tokens refuse export.
The shared intermediate keeps dots; decimal formatting belongs to the downstream engine.
Two consecutive builds and a clean checkout build must reproduce that digest.

At enable step E, first wait for or cancel every in-flight bundle.yml run: its old concurrency
group and force-push could overwrite the first pipeline bundle. Then replace bundle.yml with pipeline.yml
in the SAME commit and copy .publisher. Fill config.json from config.example.json with the
trusted Worker /publish/key URL and independently verified SPKI fingerprint, PIN.sourceSha,
verified generator commit and its facts/aliases. Empty example facts are not production inputs.
Set runUrl to the installed workflow run URL when preparing config. No private key belongs here.
Use `install.mjs` to write `config.json` and `.publisher/installed.json` together, and commit
both in the same installation commit. The small version-1 metadata binds `generatorSha`
to the Git blob OID of the exact installed config bytes. Globals reads verify that binding
at the current data head, and fail closed if it is missing, malformed, or stale. Re-run
the installer whenever changing the installed config; hand-editing only config invalidates it.
Verify Actions permissions and branch rules before enabling publish writes in a later release:
data/live must deny force-push/deletion, candidate refs must permit create/CAS/delete. Trusted
writers control workflows and .publisher; the neighboring PIN detects corruption, not a hostile writer.

The installed command is:
`node .publisher/publisher.mjs --pipeline-dry-run . .publisher/config.json <artifact directory>`.
It fetches latest remote branch heads after getting the serialized slot, publishes the real data
bundle with an explicit lease, simulates at most 20 operations/20 minutes in a no-remote bare copy,
then unconditionally fetches again and catches the real bundle up. Prior sourceCommit must be
an ancestor; already-current bundles are skipped. A bundle lease race fails closed and is repaired
on the next run. Source and live branches, candidate refs, requests, logs and pushed markers are
NEVER pushed by this transport. The simulation's bundle is artifact-only. Public-key fetches are
HTTPS, forbid redirects, have a 15-second timeout and require the independent fingerprint.
A failed key fetch/drain still gets a real bundle catch-up and result/summary artifacts.
Bundle construction validates core tooltip, permissions and pushed schemas, canonical filenames,
matching tooltip hashes and a non-empty tooltip set before any ref update; invalid data keeps the
previous remote bundle. Simulation artifacts exclude all fetched remote history (and the real
bundle just published). would-be-commits.json lists prerequisite commits; when commits is zero,
no Git bundle is emitted. Otherwise fetch would-be-commits.bundle into a clone containing those
prerequisites to inspect the simulated heads.

The publisher owns only bundle.json on editor-data-bundle. Every bundle push, dry-run included,
carries every other file of the previous bundle forward byte-identical, so the report catalogs
(report-items.json and report-items.worker.json, read by web Reports and the Worker's /reports)
survive it. The same workflow run then rebuilds them in two jobs that replace bundle.yml's catalog
step with its inputs (generator v2, editor 0acd005c). `report-items` (read-only token, after the
pipeline job unless the run was cancelled) builds both catalogs for the bundle head it read;
`report-items-push` (separate runner, contents:write) checks that the head has not moved, that the
artifact holds exactly the two catalogs, and that each is v1 for that bundle's sourceCommit. It then
pushes one fast-forward commit leased on that head (never --force), or does nothing when the
catalogs are already current. A moved head fails the job and leaves the branch untouched; the next
run rebuilds the catalogs. The workflow's concurrency group serializes all three jobs.

All editor-data pushes (requests, kicks, saves) start the pipeline. GITHUB_TOKEN bundle pushes
suppress downstream workflows; no workflow_dispatch/schedule is registered on production live.
The bounded in-run catch-up watchdog runs before/after drain, including empty/failed drains.
Pending count/recovery instructions appear in the job summary and result.json, and publishQueue
is visible in the real bundle. P1 recovery between runs requires the authorized client once-after-3-min
kick, maintainer/editor Retry, or another save (P1-B API and P1-D UI). There is NO unattended cron
watchdog in P1; Phase 3 owns that gate. Do not claim automatic unattended recovery after a final crash.
Dry-run intentionally leaves every remote request pending. Replaced pending Actions runs cannot
lose that durable queue; cancel-in-progress:false protects an executing job. Test-only local fixtures
prove data/live/candidate refs stay untouched, even if a save arrives during the simulation or key
verification fails. Existing P1-A fixtures cover ambiguous publication/RECORD recovery and golden parity.

## P1-E1 enable-ready release

The shared build switch is `config/publisher.json`, default OFF. It controls both the Worker's
legacy/new write routes and Vite's VITE_PUBLISHER_ENABLED constant; shell overrides cannot split
the two builds. The installed dry-run command continues to simulate even when this switch is ON.
See [E2-RUNBOOK.md](./E2-RUNBOOK.md) for local-only install preparation, preview CPU measurement,
first-output parity, and rollback. No remote measurements or installation are performed by E1.
`node scripts/publisher/cpu/smoke.mjs` verifies all 16 synthetic endpoint/size cases without a server.
`npx vitest run scripts/publisher/startup.test.ts` dry-run bundles the harness and real Worker,
then imports both without invoking handlers under a shim that rejects startup randomness,
crypto, network I/O and timers. It also checks lazy per-isolate UUID and invocation metadata.
The harness creates its isolate ID on the first request, never during Worker startup.

## CPU-bounded logical publishes

The browser saves a confirmed selection atomically as chunks of 50 hashes, each with its own
stable opId, immutable body, signature, numeric role check and CAS reconciliation. It sends the
chunks sequentially and shows one logical activity row. Success requires every chunk to finish
successfully; mixed outcomes are explicitly incomplete. Completed chunks may go live before
others, so the whole selection is no longer atomic. Retry and reload reuse the original identities.
Chunk metadata is local to this browser; repository queue entries remain individual requests.

Imported HMAC, RSA and Ed25519 keys use bounded single-entry caches keyed by the exact secret.
Only completed CryptoKeys/derived public metadata are shared; rotation or missing secrets cannot
hit another key. GitHub installation tokens are deliberately fetched per request: caching them
would mask installation/key revocation until expiry. Permissions are read from the current head
on every request and CAS retry. Full request signing, digest format and byte/schema checks remain.

Run `node scripts/publisher/cpu/local.mjs` for synthetic no-network local CPU measurements and
V8 profiles of publish, pending status, terminal status and kick at 1/50/100/2511 hashes. On Windows,
process CPU has coarse ticks: each of 30 samples is a mean of 20 requests, after 20 warmups. p95
is a percentile of batch means, **not** a per-request tail percentile. Cold values are wall time.
Set `CPU_BASELINE=1` to bundle the original hot paths from commit 30c0a5a with the same fixture.
`node scripts/publisher/cpu/profile.mjs <file.cpuprofile>` gives approximate stack attribution and
self-sampled hotspots; asynchronous native crypto may be charged to runtime/idle frames.
The fixture precomputes upstream JSON and honors OID-only projections. It excludes network
latency but includes synthetic Response construction. Node timings cannot certify Workers CPU;
real Workers tail measurements on the Free plan remain a release gate, including cold requests.
The existing preview harness accepts size 50 for that follow-up. No plan change is required.

## P1-F remote transport (disabled)

`RemoteRepository` uses a disposable bare object cache and real Git fetch/push. It implements
the simulator interface, preserves inherited executable/symlink/gitlink modes, and restricts
remote refs to editor-data, converter-v2-test, editor-data-bundle and validated candidate IDs.
The GitHub target is fixed to Database-Clarity/Live-Clarity-Database; credentials come from
GITHUB_TOKEN via process-local Git configuration, never the URL or command line. Remote
diagnostics are redacted and subprocesses have a 120-second timeout.

Every push uses an explicit expected-old lease (empty for create-only candidates). Data/live
and bundle commits must also descend from that old commit; unconditional force is never used.
Candidate swaps/deletion require their exact old OID. Missing per-ref acknowledgement,
disconnects and timeouts remain unresolved until fresh ref/receipt reads reconcile them.
Publisher retries the stored exact candidate, persists rebases by candidate CAS, and stops
the drain on unresolved publication or RECORD failure. Required data/live no-rewind/no-delete
rulesets remain an enablement prerequisite.

Future enablement requires all three: the shared build switch ON, installed config
`publishWritesEnabled: true`, and explicit `--pipeline-publish` invocation. The shipped example
config is false and workflow still invokes `--pipeline-dry-run`. Its token environment is ready
for the future command; this change neither installs the template nor enables writes.

The entire publisher fixture suite runs for both the simulator and local bare remotes over
file:// with real receive-pack. A separate contract compares CAS/tree/history results; faults
cover dropped responses before/after pushes and a real pre-receive timeout. Tests use no
GitHub publication calls. Run `npm test -- scripts/publisher --maxWorkers=2`.

## Scheduled batches (P4, merge held until phase-B step 4)

Spec: `.agents/reports/scheduled-changes/spec.md` (local coordination file). Contracts come only
from `@clarity/core/schedule`; `packages/core/src/publishRequest.ts` adds the request union
(`parsePublishRequestPayload`, `publishRequestIntentDigest`). `push` keeps its schema and digest
byte-identical. The batch member is loaded with a dynamic import, because core/schedule reads
publishRequest exports at load time and a static import would form a load-order cycle. esbuild
inlines it into publisher.mjs; batch.test.ts drains a batch through a freshly built runtime.

- Queue: a `batch` request drains once its notBefore is at or before the runner clock. It sits
  before the first push created at or after max(notBefore, createdAt); pushes keep their git
  addition order. A batch already claimed by its opId (its run died) drains before everything
  else. A batch that is not yet due is neither drained nor counted as pending:
  bundle.json lists it under `scheduledQueue` (key omitted while empty), and publishQueue batch
  entries add `kind`, `batchId`, and `notBefore`.
- Claim (I2): at head S, the publisher checks the signature, the key pin, and the requester's
  role. batch.json must be `scheduled` for this opId, with the signed contentRevision and
  notBefore; anything else is `superseded`. The members must equal the signed hash list, and
  approvedDigest is recomputed from them (`rejected` on a mismatch). A hash with an activation
  conflict file is rejected. Per member: non-translation merge3 against current (`stale` with
  fields, `$exists` per R14), then composition (`stale` for C3), and `unpublished` fields are
  refused as stale (root ruling). The manual content checks and the export run before ONE CAS
  commit S → S'. That commit sets status publishing and the claim, marks the due entry claimed,
  and updates the index. A race or an ambiguous CAS returns to run(), which re-reads the queue
  order and re-validates from the top. A batch this opId already claimed (a run died after the
  claim) resumes from S'. S' is found by binary search over first-parent history (the claimed
  commits are one suffix), failing closed unless the boundary is proven.
- Candidate and live write: the unchanged path, with receipt.sourceCommit = S' and the receipt
  also carrying `batchId` and `contentRevision`. Entries are the composed tooltips (English and
  the Bungie snapshot keep the stamps activation will keep, so live equals a manual publish of
  the activated tooltip; content always comes from the proposal), whose
  live/tooltips blobs are rewritten from S' at RECORD and must match the receipt OIDs (fail
  closed).
- RECORD: one commit. It writes the log (times add `landedAt`, `landedAtSource` 'cas' | 'observed',
  and `recordedAt`, all ISO), pushed.json, and the composed live snapshots. Activation runs per
  member: merge3(base@S', current@H, proposed@S') with Q4 and R14. A clean member writes
  tooltips/<hash>.json; a conflicted one keeps current and gets
  schedule/activation-conflicts/<hash>.json (never overwritten). batch.json becomes `published`
  (or a published batch with an `unchanged` result), the due entry is removed, and the index is
  updated.
- Failure without a live write (stale, rejected, superseded): the same RECORD commit returns
  the batch to draft (opId, claim, notBefore, and zone null, `result` kept), but only while
  batch.json still names this opId (R15). The opId's due entry is removed either way.
- Every manual `push` naming a hash with a conflict file is rejected before candidate creation
  ("Resolve the batch activation first", R3).
- Events past 200 move to `schedule/batches/<id>/events/<seq>.json` (seq = the 8-digit count
  already archived; root ruling), in the same commit. due.json and index.json are advisory: a
  missing or malformed file is left as it is, never a reason to stop the queue.
- PIN capability `scheduledBatches`: build.mjs refuses to write a PIN unless the bundle contains
  the claim and batch RECORD. The template is re-pinned with it at the P4 merge (root
  2026-11-14, after phase-B step 4; "Current template source" above). `PUBLISHER_DIST` builds
  into another directory.

`npx vitest run scripts/publisher/batch.test.ts` runs every P4 publisher fixture (simulator, with
the core path also over the local bare remote).

The arrowSymbol capability retains <arrow/> in the shared intermediate. The separately installed converter engine lowers it to 🠚 in the seven legacy files; clarityV2 and custom exports retain the symbol, with → available as their formatting fallback.

## Arrow symbol rollout precondition

Before installing an `arrowSymbol` publisher PIN in editor-data, install the
`.exports/` converter engine built from source commit
`83da713384bb0c399209e43851e32fca5e035ca1` or a descendant that includes its arrow
lowering. Verify that its `buildLegacy` emits U+1F81A for `<arrow/>` in all seven
old-URL files, and record the installed `.exports/PIN`.

This engine installation is also required before enabling publisher writes to
the production `converter` branch. The publisher preserves `<arrow/>` in the
shared `liveDescriptions.json` intermediate; its `arrowSymbol` capability alone
does not update or verify the downstream converter. An older engine or the held
npm converter drops the arrow. Keep the Worker's PIN gate closed until both
components are installed. Installs and cut-over remain owner-gated.

## Number tokens rollout precondition

Before enabling number-token saves through a `numberTokens` publisher PIN, install the matching
`.exports/` engine that formats numbers after maths per language, including English fallback.
Verify all seven legacy outputs, clarityV2, and liveDescriptions against the real editor-data
snapshot byte for byte, and keep `legacy-sha256.json` unchanged. The engine must also refuse
any unresolved `#{=`. Record `.exports/PIN`, the publisher source SHA, and its runtime digest.
The publisher PIN retains every existing capability, including `arrowSymbol` and `inactiveMoves`;
their installation and rollback preconditions still apply. Root installs after both independent
reviews and exact-tree CI approve. This source change performs no installation or cut-over.
