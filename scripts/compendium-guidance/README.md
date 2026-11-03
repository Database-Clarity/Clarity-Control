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
contains the complete high/medium/owner/out-of-scope tiers, per-entry rules, source snapshots
and evidence. `reasonGroups` includes only in-scope entries; `out-of-scope.json` retains the
excluded membership separately, just like the review page's collapsed Not needed list.
Current stat/ghost exclusions remain visible and restorable even if a stale-guidance
renewal is blocked by a backup failure; that never bypasses baseline gates for links.
Weapon scope requires a proven first/second-column use plus a complete stat-only
description, nonzero unconditional investment stats and no extra manifest perks.
Additional uses of that same inventory item in later columns do not change its
proven stat-only effect. Audited recoil-control and rate-of-fire wording is supported;
functional highlighting, unknown text and stat-bearing armor mods with blank
descriptions remain in scope.

A reference renews only if its existing sample evidence matches the current canonical category
entry and its selected link still resolves to the same source fingerprint. Only the baseline
commit gate is bypassed during that comparison. Missing entries, changed English, catalog or
source content stay stale; the matcher cannot infer over an unresolved recorded owner sample.
New entries never join the frozen guidance membership. Background and run textAlign are
excluded from cell comparisons and fingerprints; normalized adjacent runs merge after alignment
is removed. Text, color, bold, italic, underline, strike, sizePt, href, coordinates, spans and
selection structure remain strict. Positive legacy references replay the old nested sheet hash
against current editor/catalog evidence AND validate the saved source hash and current styled
selection. Their evidence is then migrated to the current baseline; unrelated sheet edits do
not revoke those positive selections. Negative/skipped/note-only references retain whole-sheet
change detection. Exotic Armor duplicate suppression requires identical approved bodies and a
surviving physical spanning description cell covering the approved duplicate offsets.
The four Collective base/enhanced entries have pinned prior source-body evidence from the
2026-11-02 matcher baseline; changed text stays withheld until an explicit current owner reference.
This is change detection using the app's existing fingerprints, not a security proof.

The hosted Compendium review automatically renews unchanged references on a stale baseline
after preserving a localStorage backup, and reports carried-over/re-check counts. Import
remains a fallback: expand Backup / disk recovery, export the current backup, and use Import
guidance backup to load the renewed file. Replacement requires confirmation;
invalid schema, another dataset, disk conflicts, and concurrent changes while reading refuse
replacement. Import uses browser backup/local guidance persistence only. It never sends to the
Worker. High acceptance and medium review retain the existing LOCAL link-only draft semantics;
Review & save drafts and Send to agents remain separate explicit actions.
