# Legacy editor data migration

Run from this directory on Node >=20.19:

```sh
npm ci
npm run typecheck
npm test
npm run migrate -- --output <isolated-editor-data-checkout>
```

This is a standalone tooling package, not an app workspace. Root lint covers its
source; its own typecheck and tests are required in addition to the root checks.
It imports `migrateLegacy`, `publishableHash` and schemas from `@clarity/core`.

By default the command fetches current public
`Live-Clarity-Database/intermediate/intermediateDescriptions.json` and
`converter/liveDescriptions.json`. To pin inputs or run fixture data, provide
both `--intermediate <file>` and `--live <file>`. The owner's numeric GitHub ID
is resolved from `https://api.github.com/users/StardustD2` unless a pinned public
GitHub identity JSON is supplied with `--owner <identity.json>` for an offline
rehearsal. Both paths require a positive numeric ID and the exact StardustD2
login; failed fetches or invalid data fail the command.

The output directory must be an isolated checkout of `editor-data` (or an empty
staging directory for its initial orphan commit), never a production branch.
The script **defaults to a dry run**, printing an exact file diff (operations,
before/after contents and SHA256s). `--diff <new-json>` saves that diff exclusively
without replacing an existing report. It plans tooltips, permissions, pushed
digests and the checked-in bundle workflow/script/README templates. The low-level writer removes numeric
tooltip files omitted from the prepared result; the CLI rerun retains existing
tooltips. Unexpected entries in `tooltips` are rejected. Other output files are
left alone. JSON keys are stable, with 2-space indentation and a final newline.
Rerunning on the same inputs produces identical data files. Existing JSON whose
value is unchanged is preserved byte-for-byte (including authored ordering and
line endings); changed JSON retains an existing uniform CRLF newline convention.

**No changed existing file is implicitly overwritten or deleted**, including
authored README, workflow, script, tooltip, config, marker or archive files.
After reviewing the diff, use `--write --approve <reviewed-diff.json>` to apply
only that exact diff. Stale approvals fail before writes. The alternative
`--write --allow-authored-overwrite` is an explicit opt-in to the printed current
diff, intended only for disposable rehearsal copies. Unmanaged files are never
changed. Do not use that broad opt-in for the eventual reviewed real-data run.

All destination contents are staged to temporary files on the same filesystem
before replacement. Existing files are renamed into transaction backups; any
runtime write/swap failure rolls back completed changes, including removals,
archives, file modes and newly created directories. Mid-write injected failures
are covered for both migration and folding. Unexpected concurrent byte changes
are rejected. If rollback itself fails, the command reports every failure and
the retained backup location; do not retry without recovery. This is not a
cross-process lock or a power-loss-safe database transaction: freeze external
data writers for the approved run and retain a pristine source snapshot.

**Rehearse any cut-over rerun in isolation first.** When the output already has
editor-data, the CLI validates and preserves every existing tooltip in full,
including v2-only tooltips, metadata, associations and translations. Existing
permissions and pushed markers (including absent pending markers) also win.
Legacy inputs only add missing tooltips and their live baselines **after deletion
review**. Existing git checkouts require complete, non-shallow deletion history.
Copied staging directories must supply `--deletions <pinned-hashes.json>`, a JSON
array of every historically deleted numeric tooltip hash. Intentionally absent
hashes and their live markers are not reimported. Previously deleted hashes
already present in v2 remain authored objects. A reviewed frame repair may opt
in to individual historical members via repeated `--reimport <hash>`; this is
not permission to resurrect unrelated deletions. Folding also refuses to
recreate an intentionally deleted canonical. Incomplete or
invalid existing data fails before any write. Use an empty staging directory
only for an initial migration; `writeMigration` is the low-level replacement
writer, so programmatic reruns must pass `readMigration(output)` to
`prepareMigration` first, passing the reviewed excluded-deletion list as its
fifth argument. Calling it on existing data without deletion history fails.

For a single transactional migration-plus-fold rerun, pass `--aliases <json>
--items <json> --conflicts <file-inside-output>` to the migration CLI. Both stages
are prepared in memory and the final diff is committed once, rather than leaving
an intermediate migration committed if folding fails. All imported member
originals are preserved in `<conflicts>.originals.json`.

Review the exact staged diff, commit as the owner, and push only to
`editor-data`; this triggers its bundle Action. It never writes to the remote
itself or touches `intermediate`, `converter`, `live` or `main`.

`live/pushed.json` hashes the migrated converter data, not the intermediate data.
Printed pending count compares each migrated intermediate tooltip against that
baseline using core `publishableHash`: per-language text strings, associations
and custom facts only. Preserved legacy metadata (including upload timestamps
and flags), edit credits and snapshots do not create pending changes.

## Initial publication

Create an orphan git repository in the output directory, add the generated
files, commit, and push `HEAD:refs/heads/editor-data` with the owner's local
credentials. Never force-push `editor-data`. The Action alone force-pushes a
single-file orphan commit to `editor-data-bundle`. Verify its run succeeded and:

```text
https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json
```

The returned `sourceCommit` must match the `editor-data` source commit.
No bot-generated commit is added to the authored branch.

## Same-name frame folding

After generating the new generic aliases, run from this directory:

```powershell
npm exec tsx -- foldFramesCli.ts --data <isolated-editor-data-checkout> --aliases <aliases.json> --items <items.json> --conflicts <review-notes.md>
```

This defaults to a dry run. Supply deletion history as above; save its diff with
`--diff <new-json>`, then use `--write --approve <reviewed-diff.json>` only after
review. Conflict notes must be inside the data directory so archives and data
participate in the same transaction. Equal per-language texts retain canonical credits; different
texts always prefer nonempty text over empty or whitespace-only text, even if
the blank is newer or intentional (owner decision 4B). Among nonempty texts,
take the newest per-language revision (ties prefer canonical, then lowest hash).
Missing canonical tooltips are created. This recovers the agreed Aggressive
Burst ("Hard-hitting four-burst fire."), Heavy Burst ("Hard-hitting two-burst
fire.") and MIDA Synergy lightweight/handling member text when those legacy
members are present in the staged rerun. It does not invent text if every
member is blank. The owner accepts existing shared grouped wording without
weapon-type filtering or splitting (decisions 1A 2A 3B 4B 5B).

Every replaced text is archived
losslessly with its hash, language, author and date before any deletion; complete
original objects (including imported members absent from git history) are kept
in the companion `.originals.json` archive, retaining prior versions on repeat
folds. Associations are unioned and resolved
through aliases. Other canonical metadata is retained. Group pushed markers are
cleared so each group's new live aliases must be published once. Review and commit
the data changes with the folded hash list, push only to `editor-data`, then
verify its bundle Action. This command never commits or pushes.
