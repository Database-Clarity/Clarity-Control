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
