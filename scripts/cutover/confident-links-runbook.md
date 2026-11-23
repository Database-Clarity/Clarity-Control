# First-upload confident links (S3)

Preparation only. No data write, deploy, publisher hook, or approval is supplied by
this slice. G6 requires owner approval of the exact candidate and the write after
cut-over. All existing human links remain authoritative, including unresolved
links. Archived and unknown entries, aliases, ambiguous matches, and similarity
suggestions are skipped. The app's shared displayMatches pipeline (review
evidence, resolver proposals, and shipped approved guidance) decides the set and
row. Only matches actually shown
are persisted, with the same confirmCompendiumSelection payload. The core
resolver is reached through that pipeline, never called in parallel by S3.

## Pinned dry run

Run the tool from the reviewed, immutable editor engine commit. Build the CLI with
the repository's esbuild dependency, outside the repository:

```powershell
python -I D:/GitHub/Description-editor/.agents/t3/suite-lock/heavy.py npx esbuild scripts/cutover/confident-links.ts --bundle --platform=node --format=esm --outfile=C:/Temp/confident-links.mjs
node --input-type=module -e "import(process.argv[1]).then(m => m.runCli(process.argv.slice(2)))" file:///C:/Temp/confident-links.mjs --input C:/Temp/pinned-inputs.json --out C:/Temp/NEW-candidate
```

`Inputs` contains full 40-character `editorHead`, `engineCommit`, `catalogCommit`,
and `compendiumCommit`, a fixed ISO `snapshotAt`, exact UTF-8 `itemsJson`,
`categoriesJson`, `aliasesJson`, and `compendiumJson` blobs; nullable exact
`inactiveJson`, `aliasGroupsJson`, and `sandboxPointersJson` editor-data config blobs (null means
absent at editorHead); nullable `sandboxConflictsJson` from the same generator
commit (required for accepted alias groups or a sandbox pick with a target); and `files` mapping every
tracked `tooltips/<hash>.json` to its exact Git blob bytes. Fetch immutable Git
objects, never a mutable working directory or mixed bundle/branch snapshots.
Catalog items, categories, aliases, and sandbox conflicts come from the same
generator commit (`templates/v2` on its v2 branch).
Include the entire tooltip inventory, not the selected upload hashes. Pin
`config/inactive.json`, `config/alias-groups.json`, and `config/sandbox-pointers.json` at that same editor head.
Accepted groups and sandbox picks compose through the same core function used by
the app. The planner pins the shipped guidance's canonical SHA-256 and category
blob bytes, uses tracked tabs only, and passes no drafts, local guidance, or
personal review progress to displayMatches. Engine identity and repository/ref
provenance are trusted adapter inputs: the library
cannot prove that a caller's commit label names the executing source or blobs.

The output directory must not exist. It receives `manifest.json` (exact before and
after bytes, absence markers, SHA-256 digests, complete inventory digests, source
pins, and row census) and `backup.json` (digest-bound before-images). Store both
durably, and review the printed manifest SHA-256. Existing language text,
timestamps, associations, and other fields retain their values. Changed JSON is
formatted with two-space indentation and a final newline. Newly linked catalog
entries without authored tooltips get metadata-only records, never invented text.

CLI invocation is explicit through exported `runCli(args)`: importing or bundling
the library never parses host arguments, writes files, or changes the exit status.
Running the bundled module alone does nothing; use the launcher command above.
The CLI has no write command. Repeated preparation with identical inputs produces
identical bytes. A fresh snapshot or editor head requires a new plan and approval.

## S2 first-upload interface and ordering

1. Pause admission of the first post-cut-over upload before selecting its consumer
   input or recording its publish receipt. Read all pinned Git blobs and source
   identities. Call `plan(inputs)`; obtain G6 owner approval for that manifest's
   digest and the write, and durably retain `backup(manifest)` before any mutation.
2. Call `applyApproved(store, manifest, approvedManifestSha256, savedBackup)`.
   Supply the explicit digest approved by the owner; do not derive approval from
   the currently generated plan or expose it to an unprivileged upload caller.
   The argument alone is not an authorization system. S2 enforces maintainer
   authorization, post-cut-over timing, approved engine identity, and G6 approval.
3. `Store.read()` returns an immutable, complete `Inputs` snapshot.
   `Store.compareAndSwap(expected, changes, manifestSha256)` must create one Git
   tree/commit, then atomically advance the editor-data ref only if its expected
   head still matches. Verify all original inventory bytes, immutable source pins,
   and absence markers. Serialize migration against uploads and source/config
   changes; source-pin changes invalidate admission. A local write loop, several
   Worker saves, or checking the ref before an unconditional push is insufficient.
   A ref conflict returns false, with no partial visible changes. S3 deliberately
   supplies no production adapter, Worker route, or local data-file writer.
4. The library reads back all persisted files and verifies their exact inventory.
   Rebuild the normal editor bundle from the returned persisted head, and call
   `verifyBundle(manifest, persistedInputs, bundle)`. This checks the bundle's
   source commit, alias groups, and every tooltip against the persisted inputs.
   Run the existing consumer exporter; core excludes text-less descriptions.
   Never export link-only records directly as consumer tooltips.
5. Only then produce the first upload's consumer inputs and publish receipt using
   that new editor head, including all newly persisted links regardless of which
   tooltips were selected. Record the migration digest and resulting head in the
   receipt. Never defer migration to the second upload. Resume intake after
   receipt reconciliation; a failed bundle/export/publish leaves intake stopped.

On a connection loss before or after ref CAS, read and retry the same approved
manifest. Exact after-images with unchanged source pins return `noop`; exact
before-images at the original head can retry. Partial state, any intervening edit,
or stale pins refuse. No automatic restore can overwrite a concurrent edit.
An already completed migration with later legitimate edits is reconciled through
the S2 receipt, not by repeatedly invoking the original migration forever.

For forward rollback, stop intake, read the exact committed after state, and call
`planRollback(originalManifest, currentInputs)`. Obtain a separate owner approval
for that new digest and backup. Call `applyApproved` with the rollback manifest,
its approval and backup, and the original manifest as the final argument. Commit
this inverse tree by the same atomic ref CAS, verify the rebuilt bundle, and
reconcile receipts. New metadata-only files are removed by absence markers.
Intervening edits cause refusal and require a separately reviewed recovery plan.
Never reset or force-push history, or silently reuse the forward approval.

## Verification

```powershell
python -I D:/GitHub/Description-editor/.agents/t3/suite-lock/heavy.py npx vitest run scripts/cutover/confident-links.test.ts
python -I D:/GitHub/Description-editor/.agents/t3/suite-lock/heavy.py npx eslint scripts/cutover
```

The focused tests exercise the real resolver, complete-catalog first upload,
human links, alias cycles, ambiguity, absent and text-less records, consumer
exclusion, fixed timestamps, stale inputs, forged plans, CAS conflicts,
connection-loss replay, persisted verification, bundle verification, and forward
rollback. The shipped real Compendium fixture exercises multipart and set-bonus
matching; the preparation report records a separate pinned real-data dry run.
Production atomicity, approval enforcement, receipt reconciliation, and hosted
bundle regeneration remain S2/G6 integration gates, not claims of these unit tests.
