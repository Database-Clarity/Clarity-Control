# Publisher (publish writes disabled)

`npm run build:publisher` builds the plain Node 24 CLI and integrity PIN in `dist/`.
`node scripts/publisher/dist/publisher.mjs --dry-run <local repository> <config.json> <artifact directory>`
copies the input into a disposable bare simulator, runs the serialized pipeline, and emits a Git bundle
of would-be commits plus result.json. It never changes the source or contacts a remote.

Config supplies repo, dataBranch, liveBranch, publicKey (PEM from the independently trusted Worker key
endpoint), keyFingerprint (SHA-256 of SPKI DER, pinned independently), publisherSha, generatorSha,
facts, aliases, and runUrl. Facts and aliases must come from the pinned generator commit.
The standalone dry-run does not fetch keys or provide a write enable switch.
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

Request creation is head-bound CAS. A caller must consult `classifyPublishIntent` at each fresh head;
creation timestamps are checked only for a new operation. No batches or coalescing are implemented.

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
The plain Node 24 runtime includes packages/core and has no runtime npm dependencies.
`npm run build:publisher -- --template` rebuilds both runtime and PIN from the committed
source HEAD. Commit source first, then build/commit the generated files so the source pin
identifies the exact implementation. Do not edit generated publisher.mjs by hand.

Current template source: `97331797d833a86033ebb73dcd28578e94bb13f1` (v2).
Runtime SHA-256: `31abdf39fe3839ff00acd94fb48f0757452179f872d7ea541b7112720264c1a8`.
This includes set-bonus pieces, name relinks, armor-set-bonus categories and alias-group schemas.
Permissions accept the optional export `partners` map while retaining strict validation.
The current core barrel also includes unused report-schema initialization in this runtime.
Two consecutive builds and a clean checkout build must reproduce that digest.

At enable step E, first wait for or cancel every in-flight bundle.yml run: its old concurrency
group and force-push could overwrite the first pipeline bundle. Then replace bundle.yml with pipeline.yml
in the SAME commit and copy .publisher. Fill config.json from config.example.json with the
trusted Worker /publish/key URL and independently verified SPKI fingerprint, PIN.sourceSha,
verified generator commit and its facts/aliases. Empty example facts are not production inputs.
Set runUrl to the installed workflow run URL when preparing config. No private key belongs here.
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
