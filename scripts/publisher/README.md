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
candidate ref swaps/deletes require exact old OIDs. Backoff is injectable for transport tests.

Receipts include frozen export inputs so rebasing never revalidates content or changes the timestamp.
Terminal logs contain recordCommit:null because embedding a commit's own hash is circular; consumers
resolve the recording commit from first-parent history of the log path. Rejected/stale operations have
no liveCommit. Bundle updates use CAS and source ancestry, including on failed/empty drains.

Request creation is head-bound CAS. A caller must consult `classifyPublishIntent` at each fresh head;
creation timestamps are checked only for a new operation. No batches or coalescing are implemented.
