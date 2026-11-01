# Compendium matching pass 2

Implementation: Codex gpt-6.1-sol/high, assigned isolated checkout `C:/Users/Seleo/.t3/worktrees/Description-editor/t3-f9dfe591`, branch `t3/implement-compendium-pass2`. Initial HEAD `f6322201e569259d2a3047d7971759fe413445af`, clean. Fast-forwarded only this checkout to full remote pass1 `d7af50d684bedd26dbbd150d63a5d16a3f303c65`. No delegation or integration.

Result: **1336 high / 601 medium / 666 owner**, total 2,603. The requested owner target (~250) is **not met**. Owner remainder falls from 1,825 to 666 (64% reduction). We do not convert no-candidate entries into fabricated links or treat the owner's 'most stat-only perks' observation as an executable slot classifier: the loaded manifest does not expose investmentStats/plug-slot identity. This needs a bounded follow-up with richer manifest evidence or explicit family-level owner decisions.

Authoritative guidance SHA256 `f28b42c51b1eb534cd573aef35ec8561d0e0aac531223a53d15b5dd2b87e4c72`. Guidance/current baseline both `7f30612421b1b2dbf0306de15476495b35badbc1|8012327:1670865501`; scope agrees, zero stale-reference issues. Guidance and attachments read only. No remote data writes.

## Prior remainder grouped by reason

| Prior reason | Entries |
| --- | ---: |
| No exact validated resolver proposal. | 1407 |
| Fewer than two comparable owner references support this source section. | 402 |
| Owner sample unresolved or stale; not inferred. | 6 |
| Fuzzy or ambiguous source requires owner selection. | 10 |

## Category outcomes and owner requests

| Category | High | Medium | Owner | What I need from you |
| --- | ---: | ---: | ---: | --- |
| catalog:armor-trait-exotic | 138 | 0 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:armor-mod-general | 105 | 79 | 137 | Provide a source row or confirm no equivalent for representative exceptions: +Class / -Grenade, +Class / -Health, +Class / -Melee. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:armor-mod-activity | 5 | 58 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:armor-mod-seasonal | 22 | 0 | 13 | Provide a source row or confirm no equivalent for representative exceptions: Anti-Barrier Hand Cannon, Anti-Barrier Sniper Rifle, Concentrated Forward Firepower. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-perk | 160 | 6 | 296 | Provide a source row or confirm no equivalent for representative exceptions: 50VAL Telescopic, 9RECT Telescopic, Accelerated Coils. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-perk-exotic | 5 | 2 | 22 | Provide a source row or confirm no equivalent for representative exceptions: Anti-Taken Fletching, Balanced Grip, Balanced Tang. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-trait | 235 | 0 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:weapon-trait-exotic | 5 | 114 | 15 | Provide a source row or confirm no equivalent for representative exceptions: Aggressive Frame, Dual Speed Receiver, Field Prep. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-trait-origin | 100 | 0 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:weapon-trait-origin-exotic | 2 | 0 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:weapon-trait-enhanced | 225 | 1 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:weapon-frame | 20 | 0 | 12 | Provide a source row or confirm no equivalent for representative exceptions: Adaptive Glaive, Aggressive Glaive, Caster Frame. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-frame-exotic | 9 | 122 | 44 | Provide a source row or confirm no equivalent for representative exceptions: Command Frame II, Command Frame III, Command Frame IV. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-catalyst-exotic | 4 | 137 | 21 | Provide a source row or confirm no equivalent for representative exceptions: 4-Timer Refit, Acrius Catalyst, Colony Catalyst. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:weapon-mod | 29 | 4 | 17 | Provide a source row or confirm no equivalent for representative exceptions: Adept Accuracy, Adept Blast Radius, Adept Charge Time. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:subclass-fragment | 85 | 14 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:subclass-aspect | 36 | 16 | 8 | Provide a source row or confirm no equivalent for representative exceptions: Ascension, Bleak Watcher, Diamond Lance. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:subclass-super | 27 | 3 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:subclass-grenade | 33 | 11 | 1 | Provide a source row or confirm no equivalent for representative exceptions: Slicewire Grenade. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:subclass-melee | 25 | 16 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:subclass-class | 42 | 0 | 0 | No owner exceptions; confirm medium source descriptions individually. |
| catalog:subclass-movement | 5 | 0 | 53 | Provide a source row or confirm no equivalent for representative exceptions: Balanced Glide, Balanced Glide, Balanced Glide. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:verbs | 14 | 18 | 3 | Provide a source row or confirm no equivalent for representative exceptions: Darkness Buffs, Light Buffs, Light Debuffs. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |
| catalog:ghost-mod | 5 | 0 | 24 | Provide a source row or confirm no equivalent for representative exceptions: Blinding Light, Bountiful Harvest, Brawler Armorer. Notes/skips need an explicit decision; do not resolve the whole category from absence alone. |

## Independently checkable rules

All inferred links use current positive references from the same category to establish allowed tabs. One sample is enough to establish a tab; section labels are layout headings and do not restrict all other category members. Whole-description links pass the existing selection/resolution function. Snapshots use source.fetchedAt for deterministic revisions. Source descriptions come from the existing parsed row/configured description column, never an invented neighboring cell. A positive sample with a selected-cell override makes inferred matches in that tab medium. No arbitrary cell offset is generalized.

- `explicit-owner`: current reference applies only to its own hash, including no-equivalent. Skipped, stale and note-only samples remain owner; existing links/drafts/human outcomes are preserved.
- `unique-name-in-learned-tab`: unique normalized full name or first row-name line, in the learned tab. Normalization is the existing core function (case, accents, punctuation, trailing bracket qualifiers). This handles multiline origin metadata and enhanced/base traits using the same Compendium row.
- `fragment-short-name`: remove only Facet/Whisper/Ember/Spark/Echo/Thread of, then unique normalized name in learned tab.
- `owner-shared-armor-family`: only Heavy/Special Ammo Finder -> Ammo Finder and six elemental/Kinetic Weapon Surge -> Weapon Surge, explicitly demonstrated by the owner notes. Other armor families need individual candidates.
- `resolver-multipart-name`: exact normalized name in learned tab; existing resolver can combine same-name multipart content. Re-resolve against current source and compare snapshot before proposing. Selected-cell conventions remain medium.
- `exotic-name-line-or-catalyst`: medium only; unique exact line in composite exotic row, or weapon name after removing Catalyst suffix. No arbitrary exotic aliases/refits are invented.
- `separated-fuzzy-name`: medium only; first-line normalized trigram similarity >=0.65 and >=0.08 ahead of runner-up in learned tabs. Confirm description individually.
- `uncovered-element-tab`: medium only; unique exact name in a tab absent from that subclass/verb category samples. This makes Strand fragments and other unsampled element mappings reviewable without treating their tab convention as proven.

### Spot-checks by rule

| Rule | Entry | Source tab / row key | Tier |
| --- | --- | --- | --- |
| unique-name-in-learned-tab | Absorption Cells (2618534366) | 1500097863 / Absorption Cells | high |
| unique-name-in-learned-tab | Abyssal Extractors (3927963101) | 1500097863 / Abyssal Extractors | high |
| resolver-multipart-name | Blastwave Striders (1860418166) | 1500097863 / Blastwave Striders | high |
| resolver-multipart-name | Swarmers (2800865663) | 1500097863 / Swarmers | high |
| separated-fuzzy-name | Arc Ammo Generation (450381139) | 1934379638 / Ammo Generation / [1–2 Energy] | medium |
| separated-fuzzy-name | Arc Ammo Generation (4283953067) | 1934379638 / Ammo Generation / [1–2 Energy] | medium |
| owner-shared-armor-family | Arc Weapon Surge (1834163303) | 1934379638 / Weapon Surge / [3 Energy] | high |
| owner-shared-armor-family | Arc Weapon Surge (2246316031) | 1934379638 / Weapon Surge / [3 Energy] | high |
| exotic-name-line-or-catalyst | Enhanced Relay Defender (3630287380) | 1934379638 / Relay Defender /  / Enhanced Relay Defender | medium |
| exotic-name-line-or-catalyst | Enhanced Resistant Tether (2037533514) | 1934379638 / Resistant Tether /  / Enhanced Resistant Tether | medium |
| fragment-short-name | Echo of Cessation (3854948620) | 1907852650 / Cessation | high |
| fragment-short-name | Echo of Domineering (2272984657) | 1907852650 / Domineering | high |
| uncovered-element-tab | Thread of Ascent (4208512216) | 1870531554 / Ascent | medium |
| uncovered-element-tab | Thread of Binding (3192552688) | 1870531554 / Binding | medium |

The spot-checks above were checked for the stated name transformation, supporting reference tab, resolved description snapshot, and confidence tier. They are not an independent review of all inferred links. The full artifact includes source snapshots, each rule/reason and supporting reference evidence, source row/anchor where applicable, per-category reason groups and samples. Additional exotic refit aliases and stat-only absence families are intentionally not guessed.

## Acceptance and verification

Each category offers Preview all high / Accept all high and Review medium. The frozen preview renders every included source description. Accept all high drafts exactly its displayed high links, excluding no-equivalent decisions; medium confirmation drafts only that preselected entry. The handler re-derives the category revision and compares exact decision membership plus live draft identity before writing local link metadata. No text, association or remote writes occur. Category undo uses the same existing guarded link-only undo transaction as individual/bulk acceptance. Changed source, baseline, membership/evidence or guidance invalidates the preview; draft edits are also checked synchronously in the handler. Save remains the normal Worker pipeline.

Checks: full root typecheck, lint and tests passed: **746 passed, 1 pre-existing optional skip**. Root build passed (Vite and Worker dry-run only); existing Zod annotation and bundle-size warnings. New mounted jsdom tests exercise displayed-only acceptance, cancel/no-op, frozen revision invalidation, medium single confirmation and read-only permissions. Planner tests cover single-reference support, negative non-generalization, scoped membership, stale input/reference evidence, ambiguity/stale multipart proposals and preservation of human outcomes. Existing save/undo tests remain green. No browser/rendered acceptance or real-account/Worker save performed; independent combined pass1+2 Sol review is pending.

## Reproduction and audit artifacts

`node scripts/compendium-guidance/report.mjs <read-only-guidance.json> <new-output-dir>` fetches public data read only and refuses overwrites. Compare baseline before using output. Compressed full artifact: `compendium-match-pass2-candidate/proposals.json.gz` (gzip JSON, generated from the current matcher); adjacent summary.md is readable. Local uncompressed/intermediate artifacts remain ignored. No owner guidance/report files under D:/GitHub were edited, and no git command ran there. Ports 4179/4180 were untouched. Feature commit/push only; no PR, main merge, non-main integration, force push, Worker deploy/secrets, remote data writes, or worktree handoff.
