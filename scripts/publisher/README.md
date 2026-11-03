# Publisher P1-A (writes disabled)

`npm run build:publisher` builds the plain Node 24 CLI and integrity PIN in `dist/`.
`node scripts/publisher/dist/publisher.mjs --dry-run <local repository> <config.json> <artifact directory>`
copies the input into a disposable bare simulator, runs the serialized pipeline, and emits a Git bundle
of would-be commits plus result.json. It never changes the source or contacts a remote.

Config supplies repo, dataBranch, liveBranch, publicKey (PEM from the independently trusted Worker key
endpoint), keyFingerprint (SHA-256 of SPKI DER, pinned independently), publisherSha, generatorSha,
facts, aliases, and runUrl. Facts and aliases must come from the pinned generator commit.
No key fetching, production Git transport, workflow, Worker endpoints, or write enable switch ships
in this phase. The later transport must enforce forward-only LIVE/data refs and serialized execution;
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

`GET /publish/status?opId=<id>&opId=<id>` accepts 1–20 IDs and returns only
`{operations:[{opId,status}]}`. Status is unknown, pending, done, unchanged, stale,
rejected or failed. It costs 2 subrequests including authentication to GitHub.
`POST /publish/kick {opId}` checks the same head for an uncompleted pending
request, then creates a uniquely named kick file using the Contents API (3
subrequests). A completion racing a kick makes that kick harmless. Both status
and kick require a current numeric-ID maintainer/editor permission. Metadata
that GraphQL cannot return as complete text fails closed without REST fallbacks.
All endpoints retain the shared 48-subrequest hard cap. CPU measurement and
workflow registration/enablement belong to subsequent phases.
