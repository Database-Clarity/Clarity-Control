# Compendium baseline linking

Dry-run and reporting tool for existing `editor-data` tooltips. It fetches that
branch into Git's object store without checking it out or changing the editor
index/worktree. Manifest aliases resolve to canonical tooltips. Configured
category tabs are preferred; all tabs are searched if no name matches there.
Full names and individual identifiers in multiline name cells are considered,
including base names for enhanced variants and weapon names for catalysts.
Conservative category-specific variants cover set-bonus prefixes, elemental or
Kinetic armor mods, shared ammo mods, shortened grenade names and explicitly
mapped catalyst host names. Source names with bounded Roman-numeral ranges
also identify each included rank; ampersands normalize to "and".
Explicit exotic-trait aliases cover documented host cells and renamed source
identifiers, not arbitrary description-substring or fuzzy matches.
Same-name parts within a tab combine in sheet order, including trailing weapon-type
qualifiers; explicit configured category boundaries remain ambiguous. Ambiguous and
similarity-only matches remain unlinked with candidates in the CSV report.

From the editor repository root:

```powershell
npm exec esbuild -- scripts\compendium-link\cli.ts --bundle --platform=node --format=esm --outfile=scripts\compendium-link\dist\cli.mjs
node scripts\compendium-link\dist\cli.mjs path\to\compendium.json path\to\report
```

Outputs: `coverage.json` with the immutable source data HEAD and per-category
totals, combined-link and potential cell-override counts, `compendium-unlinked.csv` with every unresolved hash and reason, and
`baseline.json` containing only proposed changed tooltip files. Every proposal
must preserve its core `publishableHash`; otherwise the entire run fails.
Existing identical snapshots retain their timestamp, making reruns no-ops.
Existing links are never rewritten, even when their source changed or moved:
only an English edit or explicit editor review may acknowledge that change.

**Publication is a separate, owner-approved operation.** After reviewing the
coverage and receiving approval for the exact data HEAD, rerun with
`--commit-approved-head=<40-character data HEAD>`. This preserves every untouched
file, creates one metadata-only commit on top of that exact HEAD, and performs a
normal non-forced push to `editor-data`. If the branch moved, it stops: repeat
the dry run and obtain fresh approval. It never writes production branches or
changes pushed markers.

## Reviewed bounded rules (October 31, 2026)

`reviewed.ts` adds 48 hash-scoped rules before ordinary name matching. The two
small core registries contain 75 distinct dependency templates and 48 source
identities. Exact name/category/English guards include the entire import closure,
not merely a destination import line. Changed, missing, aliased or cyclic dependencies
return to human review. The optional final `autoLinkCompendium` argument supplies
the current tooltip index; import rules cannot run without their dependencies.
Existing destination links always win, including broken links.

Each current unique anchor must have the audited parsed section and supported
relative description cells, agree with the current parsed description and resolve
back to the same styled selection. This isolates Chaos Accelerant's Aspects cells,
Nightmare shared tiers, Onslaught's primary name and the single audited Grand
Overture spelling variant without changing general resolver semantics. Source text
may drift; destination templates and content never change. Multipart logic remains
in the existing resolver.

Reproduce the compact registries/hints and focused fixtures from the separately
reviewed `dispositions.json` and research `suggestions.json`/`fresh-grid.json`:

```powershell
python scripts/compendium-link/build-reviewed-registry.py <validation-directory> <research-directory>
npm exec prettier -- --write packages/core/src/compendium/reviewed-*.json packages/core/test/compendium/fixtures/reviewed-*.json apps/web/src/features/compendium/research-hints.json
```

Inspect regenerated diffs: the evidence files are inputs for maintainers, never
runtime imports or authority to publish links. Exact dependency templates represent
the audited wrapper semantics; extending this list requires another semantic audit.
Fixtures retain current styled cells and competing normalized rows rather than
historical destination snapshots. All 571 research records remain in the dated
research inventory; the app carries only compact navigation records for the 523
outside the automatic-rule set (41 human, 449 unknown, 33 provisional exclusions).

Measured against editor-data `7f30612421b1b2dbf0306de15476495b35badbc1`
and captured October 30 23:56 UTC grid: 1,988 / 2,511 linked, 22 combined,
4 ambiguous, 486 unmatched, 33 no-equivalent; zero publishable-hash changes.
The independent audit accepted fresh CSV for all 16 tabs / 1,598 rows with zero
mismatches. This is a dated capture, not a claim that the public sheet never changed
since. Old 1,918-link approval does not cover this baseline. New independent source
and rendered review, exact-candidate approvals and an integration slot remain required.
