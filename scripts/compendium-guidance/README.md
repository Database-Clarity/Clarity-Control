# Compendium guidance renewal

Run from the repository root:

```sh
node scripts/compendium-guidance/report.mjs <read-only-guidance.json> <new-output-directory> --rebaseline
```

An optional third positional argument supplies a historical bundle instead of the live bundle.
The command fetches public generator/catalog, source and editor bundle inputs read only. It
writes a new directory, never overwrites a report or the input, and creates no editor drafts.
`renewed-guidance.json` preserves owner decisions, notes, timestamps and recorded membership.
`rebaseline-audit.json` lists renewed references and those needing a re-check; `proposals.json`
contains the complete high/medium/owner tiers, per-entry rules, source snapshots and evidence.

A reference renews only if its existing sample evidence matches the current canonical category
entry and its selected link still resolves to the same source fingerprint. Only the baseline
commit gate is bypassed during that comparison. Missing entries, changed English, catalog or
source content stay stale; the matcher cannot infer over an unresolved recorded owner sample.
New entries never join the frozen guidance membership. Because sample evidence includes the
whole source-tab fingerprint, unrelated source changes conservatively require re-checking too.
This is change detection using the app's existing fingerprints, not a security proof.

In the hosted Compendium review, expand Backup / disk recovery, export the current backup,
and use Import guidance backup to load the renewed file. Replacement requires confirmation;
invalid schema, another dataset, disk conflicts, and concurrent changes while reading refuse
replacement. Import uses browser backup/local guidance persistence only. It never sends to the
Worker. High acceptance and medium review retain the existing LOCAL link-only draft semantics;
Review & save drafts and Send to agents remain separate explicit actions.
