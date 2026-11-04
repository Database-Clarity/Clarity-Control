# Compendium matching rules and maintainer decisions

This is the central reference for matching, scope, category placement and withheld outcomes. Rule IDs below are the exact `ruleId` values returned by code. Explicit owner decisions take precedence over inference; neither blank authored English nor an absent name proves no equivalent. Saved links/drafts/review decisions are preserved. A current baseline, frozen membership and source confirmation are required before proposing links; no rule here publishes data.

## General rules, narrow rules and their validation

`triageRules.test.ts` separates construction examples (the 282 owner-triaged records) from independent real manifest definitions and structural counterexamples. `ownerReviewed.test.ts`, `guidedDecisions.test.tsx`, `reviewScope.test.ts` and core compendium suites cover earlier rules. Source hashes are change detectors; manifest descriptions, socket/plug categories, actual source cells and item identity supply the semantic evidence. General inference never follows a parent-card mention alone. New item-specific decisions belong in the generated registry below, not in ad hoc name guesses.

| Rule ID | Matches / evidence / limits | Validation examples and counterexamples |
|---|---|---|
| <!-- ruleId: armor-set-perk-piece-count --> `armor-set-perk-piece-count` | Armor set-bonus catalog identity supplies the set name and 2/4 piece count. Remove only a trailing ` Set`; require the exact first-line set heading in Armor Perks / Armor Set Bonuses, and the exact `N Piece | Perk name` heading. Require one round-trippable styled block; ambiguous, missing, or renamed perks remain unresolved. Maintainer exception: Wayward Psyche Set = Uncaged Deviants. Provenance: owner, 2026-11-04, `.agents/t3/decisions-1104/decisions.html`, decision 4, “A: Link all five”. | Disaster Corps, Smoke Jumper, Iron Panoply, Wayward Psyche, and Iron Battalion, both piece counts; wrong perk/count, duplicate card, and set-conversion selectors reject. |
| <!-- ruleId: owner-reapproved-collective --> `owner-reapproved-collective` | Owner, 2026-11-04, decision 3 on `.agents/t3/decisions-1104/decisions.html`: “A: Re-approve rows 52/53”. Hash/name/category and exact styled body must agree with `owner-reviewed.json` reapproved records. Demolition 4019266109/2613226185 selects row 52; Pugilism 1888882410/3684445958 selects rewritten row 53, never old-text row 54. Pick the named card with an explicit sourceAnchor and relative description-cell offsets to avoid combining duplicate names. Original approval snapshots (bootstrap Compendium commit 6cdb31a, matching the former withholding fingerprints) supply read-only drift comparisons; renewed link approval does not approve tooltip numbers. | All four approvals, changed source/identity rejection, and fresh-storage shipped matching. |
| <!-- ruleId: armor-siphon-family --> `armor-siphon-family` | Approved element/damage-family Siphon naming on a real `enhancements.v2_head` helmet plug; unique Armor Mods / Helmet / Siphon description must describe weapon kills and Orbs. No row coordinates or hash allowlist. | Independent Harmonic 3832366019, Kinetic 897335593 and Solar 1086997255; artifact Elemental Siphon, Health Siphon, duplicate Helmet rows and a wrong buff description reject. All five triage variants pass. |
| <!-- ruleId: armor-core-variant --> `armor-core-variant` | Existing core variants/identifiers, configured tab and unique round-trippable description. Element/harmonic families, resistance and Set Bonus prefix normalization are source hints; semantic selector scope wins over an old name-only Set Bonus match. | Frozen 69 armour disagreements; independent Siphon cases above, owner-sample/multipart guards. Set-conversion New Demotic is excluded, not linked to its actual bonus card. |
| <!-- ruleId: weapon-attachment --> `weapon-attachment` | Default Weapon Attachments exclusion. Inference requires a recognised physical attachment plug on `weapon-perk`, unconditional nonzero investment stats and no effect perks. Explicit triage defaults override uncertain inference only for recorded identities. No first-two-column assumption. | Independent Arrowhead Brake 839105230, Hammer-Forged Rifling 3250034553, Hitmark IS 13792278, Tactical Mag 106909392 and Assault Mag 791862061; Ricochet 1885400500, Armour-Piercing 1968497646 and High-Caliber 1561002382 must remain in scope; conditional/stale facts reject. |
| <!-- ruleId: attachment-evidence-needed --> `attachment-evidence-needed` | Known attachment plug with effect perks, conditional or insufficient stat evidence is Attachment Effects, in scope, not inferred stat-only. No source equivalence is implied. | Independent Ricochet, Armour-Piercing and High-Caliber; Rangefinder 2846385770 and Quickdraw 706527188 are frame/trait plugs and are not reclassified as attachments. |
| <!-- ruleId: owner-classification-evidence-changed --> `owner-classification-evidence-changed` | A recorded exclusion no longer agrees with manifest identity, plug or description; keep in scope and withhold matching until category/scope is confirmed. Explicit exclusions are not blind permanent hash rules. | Changed Chambered Compensator manifest description rejects the old owner exclusion; exact original owner cases remain covered by all 282 disposition regressions. |
| <!-- ruleId: attachment-source-investigation --> `attachment-source-investigation` | Explicit seven unresolved attachment sources (base/enhanced counterparts inherit only the same named family via catalog relationships). Six required tooltips; Remote Detonation tentative. Never promote a generic parent/exotic mention. | All seven authoritative hashes below plus Coils base/enhanced relationships; fake shared names or unrelated relationships cannot inherit the exception. |
| <!-- ruleId: editor-attachment-effect --> `editor-attachment-effect` | Saved/drafted `custom.categoryId=attachment-effect` promotes a classified attachment into Attachment Effects. Normal drafts/save/conflict flow; server and control require editor or maintainer for a category change. Does not approve a source. | Arrowhead promotion preserves later English/associations; editor/maintainer accepted, trial/translator/anonymous rejected; hydration/save lock disable the control; unchanged-category text edits retain ordinary permissions. |
| <!-- ruleId: editor-attachment-override --> `editor-attachment-override` | Saved/drafted `custom.categoryId=weapon-attachment` moves an owner/manifest-classified Attachment Effect (or attachment) into Weapon Attachments (no tooltip needed). Switching back to the native category removes the override. Editor or maintainer only; does not approve a source. | Native effect moved to attachments and back is byte-identical; trial/translator/anonymous rejected. |
| <!-- ruleId: inactive-placeholder --> `inactive-placeholder` | Deprecated plug or exact locked-mod manifest template, with no stats/perks, becomes Inactive & Placeholder Items. Explicit 29 owner placements retained. Data stays viewable; deprecation is not archival. | Independent Opening Salvo 1254077559 and locked class-item mod 2535142633; Empty Mod Socket 1980618587 has neither deprecation nor unlock semantics and rejects. |
| <!-- ruleId: manifest-armor-stat --> `manifest-armor-stat` | Armour general/tuning plug changing only known player armour stats/costs; explicit thirteen owner exclusions also cover facts insufficient for inference. | Independent +Melee/-Super 311164277 and +Class/-Weapons 323635379 pass. Cost-only Minor Class 1124184622 / Melee 1763607626 stay unclassified by inference; empty sockets and unknown stat/effect evidence reject. |
| <!-- ruleId: irrelevant-selector --> `irrelevant-selector` | Manifest set-conversion selector plug plus conversion semantics, or explicit owner selector decision; never the actual set bonus. | Independent New Demotic selector 139044974; empty selector socket 666522389 is not a conversion effect; a genuine set-effect/ordinary armour plug cannot be inferred from its name. Accretion/Wayward Psyche are explicit exclusions. |
| <!-- ruleId: irrelevant-extractor --> `irrelevant-extractor` | Crafting extractor plug and obtain-pattern-progress semantics; a crafting action, not a tooltip effect. | Extract Pattern 1791833453 is construction evidence; independent raw definition 2897206615 passes, Empty Deepsight Socket 1961918267 rejects. A trait merely mentioning patterns or a different plug/description cannot infer this classification. Scope is deliberately smaller than all crafting plugs. |
| <!-- ruleId: weapon-mod-stat --> `weapon-mod-stat` | Explicit owner category/scope for Enhanced Heat Generated and Enhanced Vent Speed: Weapon Mods, no tooltip. No inferred rule for arbitrary heat/perk names. | Both owner hashes below; independent effect-bearing magazines/traits remain outside this exception. |
| <!-- ruleId: optional-movement --> `optional-movement` | Exact 53 triage movement records: retained, optional authoring, history/source investigation unresolved. Not exclusion or no-equivalent. | Every group 6–8 member checked; no blank-English exclusion. Original five guided movement negatives remain unchanged by ROOT clarification. |
| <!-- ruleId: artifact-identity-unresolved --> `artifact-identity-unresolved` | Explicit rejection: Elemental Siphon versions have different mechanics and unresolved plug/artifact mapping. | 3619040076; actual two source cells differ; core refuses their combination. Same-name agreement and the reused Implement of Curiosity preview family are insufficient. |
| <!-- ruleId: artifact-manifest-section --> `artifact-manifest-section` | Link only within a current sheet artifact section supported by manifest socket parents. Truly shared identical descriptions can use existing multipart links with all validated current parents, one match per section. | Armorsmith 2903198437 under Encrypted Data Disk and Queensfoil Censer; extra unsupported third card rejects. Different Elemental Siphon mechanics reject even when names agree. |
| <!-- ruleId: artifact-sunset --> `artifact-sunset` | A proven socket parent absent from the sheet current-artifact section list is excluded, with reason “not in a current artifact.” Missing parents alone are not proof. | Current/sunset same-name and sunset-only regressions; no current sections/unknown identity is withheld. Frozen baseline has zero proven-parent sunset cases. |
| <!-- ruleId: artifact-source-absent --> `artifact-source-absent` | Exact twelve owner-approved absent artifacts, only while no socket parent and no named current sheet source. | All twelve exclusions; Impact, Shock, Gravity owner sample is not included. A newly added source or parent invalidates the exclusion. |
| <!-- ruleId: owner-artifact-identity --> `owner-artifact-identity` | Withhold ambiguous/unestablished artifact identities; source anchors remain available for manual review. | Distinct names/rows do not establish current ownership; old preview.artifactHash reused across artifacts is rejected. |
| <!-- ruleId: owner-verified-multirow --> `owner-verified-multirow` | Explicit verified hash/name/category groups, complete source identity set and styled-cell evidence; combines via existing core. Physical description components must concatenate exactly to the parsed cell. Only identical **cooldown metadata** is shared once; variant bodies/labels remain. No weapon-type routing. Relocated rows and changed authored English do not change the approved item/source identity; new/changed source bodies or members are withheld. | Micro-Missile both cells, Hammer ordinary/Sol Invictus plus one cooldown. Independent real Glacier and Golden Gun compound-cell recovery; synthetic Nova Dive variants exercise shared/different cooldowns and relocation. Different Golden Gun identities and distinct Elemental Siphon never merge. |
| <!-- ruleId: owner-verified-cell --> `owner-verified-cell` | Individually reviewed core destination with exact item/source evidence. Slicewire includes its parsed description and cooldown. No extrapolation to all aspect/grenade names. | Six Arc/Stasis aspects and Slicewire entries below; changed/wrong neighboring cell is withheld. Independent Glacier compound-cell recovery tests the reusable structural detector. |
| <!-- ruleId: exotic-armor-card --> `exotic-armor-card` | Normal single armour card. Repeated item anchors collapse only when the same styled description physically spans both anchors in the same column. Parser uses real elements; resolver supports older published parsed data. | Swarmers and Blastwave Striders; synthetic repeated-name merged card; identical text in a separate physical cell remains multipart/ambiguous. |
| <!-- ruleId: owner-reviewed-evidence-changed --> `owner-reviewed-evidence-changed` | Withhold a known reviewed item when its hash/name/category identity, complete source set, styled description or core agreement no longer validates. Global sheet coordinates and authored text are not item identity. | Every reviewed record is tested with changed neighboring mechanics; added Adaptive row rejects; coordinate-only relocation keeps identity and source content. |
| <!-- ruleId: source-text-changed --> `source-text-changed` | Four Collective base/enhanced selections from the approved 2026-11-02 matcher baseline changed real text on Nov 3. Keep them withheld until a current explicit owner reference is saved. Pinned styled body fingerprints are in changedSourceEvidence.json. | Pinned matcher replay withholds all four; current explicit references take precedence. |
| <!-- ruleId: owner-tentative-no-equivalent --> `owner-tentative-no-equivalent` | Only exact named decision-7 / finalized triage records below, bound to full-sheet and entry fingerprints using existing `localDecision`. ROOT withdrew the 291-record blanket. | All remaining 29 records reopen after sheet additions or entry changes. Coils investigations, Siphons, movement, placeholders and unrelated blanks are not inferred no-equivalent. |
| <!-- ruleId: exotic-catalog-parent --> `exotic-catalog-parent` | Exact manifest/editor parent item names establish an exotic card. Unique parent preferred; otherwise validate the core-selected row/column/cell. Generic exotic barrel/ornament parent-only promotion is forbidden outside the exact seventeen approved exceptions. | Ranked Cranial Spike, catalyst/refit, actual multi-parent selection and wrong-parent negatives; Default Ornament/Balanced Grip are exact scoped exceptions, not a naming rule. |
| <!-- ruleId: exotic-name-line-or-catalyst --> `exotic-name-line-or-catalyst` | Token/catalyst-name convention in an owner-demonstrated tab, requiring confirmation (medium), not automatic parent semantics. | Existing token/catalyst tests, no positive reference tab and competing token rows withhold. Parent-only negatives remain meaningful. |
| <!-- ruleId: explicit-owner --> `explicit-owner` | Current reference applies only to its own hash/category/evidence/baseline. Never category-wide approval. Formatter-only multipart upgrades are allowed only when replaying the saved labels over the current complete styled source rows reproduces the old approved snapshot and source hash; changed bodies/member sets reject. Exact frozen references and original negatives are generated below. | Stale source/entry/membership, note-only/skipped references and changed baselines reject; source selection still round-trips. |
| <!-- ruleId: unique-name-in-learned-tab --> `unique-name-in-learned-tab` | Unique normalized full/first-line name in a current owner-demonstrated tab, with stable source confirmation. | Guided fixture independent Sample 102 from owner Sample 100; duplicate names, missing anchors/cells and no current positive references withhold. |
| <!-- ruleId: fragment-short-name --> `fragment-short-name` | Known Facet/Whisper/Ember/Spark/Echo/Thread prefix convention in learned source tabs; no arbitrary prefix stripping. | Existing fragment/alias core suites and fragment guidance; unrelated names and competing elemental sources are not proof. |
| <!-- ruleId: owner-shared-armor-family --> `owner-shared-armor-family` | Explicit shared Ammo Finder / elemental Weapon Surge convention in a learned tab. Not all armour mod names. | Existing shared-family fixtures and source confirmation; wrong tab, duplicate identity and unresolved owner sample reject. |
| <!-- ruleId: separated-fuzzy-name --> `separated-fuzzy-name` | Similarity >=0.65, margin >=0.08, learned tabs and stable cells; medium confirmation only. | Existing guided separated candidate / close runner-up tests. Similarity or a parent mention never makes this high-confidence approval. |
| <!-- ruleId: separated-typo-name --> `separated-typo-name` | Full normalized name >=8 chars, edit distance <=2 and runner-up distance gap >=2; medium confirmation. | Precise Jolts/Precise Jolt fixture; short strings and close competing candidates reject. |
| <!-- ruleId: uncovered-element-tab --> `uncovered-element-tab` | A unique exact subclass/verb name outside a demonstrated tab is medium, requiring tab-convention confirmation. | Existing cross-element guidance tests; several elemental hits/Prismatic variants remain ambiguous. |
| <!-- ruleId: owner-multipart-source --> `owner-multipart-source` | Unverified duplicate/multipart identity is withheld; raw anchors retained, not resolver-generated neighboring headings. | Unsupported third Armorsmith card and additional Adaptive rows; known owned groups use verified evidence, not this fallback. |
| <!-- ruleId: owner-no-candidate --> `owner-no-candidate` | Default withheld state, missing/stale samples, comments requiring interpretation, incompatible scope/baseline or no supported identity. Reasons explain which gate failed; not a no-equivalent finding. | Existing preservation, baseline, comments and stale-owner tests; empty authored English alone does not remove an entry. |
| <!-- ruleId: manifest-weapon-stat --> `manifest-weapon-stat` | Original supported stat-only scope, plus seventeen exact owner-approved exotic parent-link exclusions. Physical members of that explicit set appear in Weapon Attachments and can be editor-promoted; cosmetic Default Ornament retains its original category. Do not infer exclusion from a stat word, authored blank or generic parent card. | Existing manifest/scope predicates and seventeen exact exception tests; conditional/effect perks and unapproved hashes reject; editor promotion takes precedence over default attachment scope. |
| <!-- ruleId: manifest-retired-mod --> `manifest-retired-mod` | Original owner-supported no-equivalent family with manifest deprecated/fizzled semantics; original 27 outcomes remain unchanged. New triage deprecated placements are separately inactive, not archived. | Existing manifestRule support/template regressions; no support or misleading description rejects; no manifest-removal archive in this round. |
| <!-- ruleId: manifest-weapon-ornament --> `manifest-weapon-ornament` | Original supported ornament predicate: appearance semantics plus matching manifest categories; no broad exotic-card link. | Version Alpha/One/Prime original guided population; wrong categories/description reject. |
| <!-- ruleId: manifest-adept-mod --> `manifest-adept-mod` | Original owner-supported Adept predicate requires stats, exact requirement perk and stat-only description. Named decision-7 Adept negatives are separate explicit records. | Existing manifestRule tests for perk/requirement/template guards; effect-bearing Adept perks are not swept in. |
| <!-- ruleId: ghost-mod --> `ghost-mod` | Existing ghost-mod scope excluded by default; config can include it. No change from triage. | Existing reviewScope config/preservation tests; real non-ghost descriptions and saved links are not removed by a name match. |

### Attachment category switch identity guard

The two-way switch is enabled only when the tooltip has no `custom` identity, or `custom` exactly matches what the switch writes: the manifest name and the opposite of the native owner/manifest attachment category. Returning to the native category removes that override, restoring the original tooltip JSON even after save/reload. Other custom identities disable both buttons with a note directing users to the identity editor; the updater also leaves them untouched. This includes a manifest-named custom in the native attachment category or a non-attachment category, and any differently named custom.

No provenance or schema field is added. Accepted limitation (owner decision): a pre-existing custom byte-identical to a switch-created override is indistinguishable and remains switchable; removing it yields the same visible native classification. Regressions in `AttachmentCategoryControl.switch.test.tsx` cover guarded identities before/after save/reload, saved switch overrides in both directions, and identity changes in a draft.

### Core candidate and saved-link mechanics

These are shared subroutines used by the runtime rule families above, not additional owner approvals. `config.ts` supplies category tab preferences; `OLD` tabs are excluded. Fragment prefixes route Spark/Ember/Echo/Whisper/Thread/Facet to Arc/Solar/Void/Stasis/Strand/Prismatic respectively. Set Bonus armour names prefer Armor Perks; ordinary armour mods prefer Armor Mods. Exotic weapon traits/frames/catalysts prefer Exotic Weapons, exotic armour prefers Exotic Armors/Exotic Class, and ordinary weapon perks prefer Weapon Perks. Unknown category routing remains a hint, never identity evidence.

`compendiumNameVariants` strips known fragment prefixes, Set Bonus prefixes, elemental/harmonic armour prefixes, Heavy/Special Ammo Finder/Scout prefixes, grenade suffixes and catalyst suffixes only within their configured category. Its exact older exotic/catalyst aliases are generated below. `compendiumIdentifiers` recognizes multiline names, leading arrows/plus signs and valid I–X rank ranges. Normalization removes trailing parenthetical/bracket qualifiers, decomposes accents, folds case, expands ampersands and collapses punctuation. Direct identifiers precede normalized names, configured variants, catalog/base names and alias-family names. Preferred tabs are searched in order before tracked-tab fallback. These mechanics feed `armor-core-variant`, `fragment-short-name`, `exotic-catalog-parent` and the learned-name rules, each with its own approval gates.

Core proposals can combine same normalized names only within one tab and one configured category boundary; the guided matcher additionally requires approved multipart identity. Physical merged armour cards deduplicate by cell identity, not merely equal text. Saved section names disambiguate category collisions; ordered relative-cell overrides must resolve completely and never fall back to configured cells. Saved links search their original tab/name first and then normalized relocated names. Styled snapshots and multipart labels detect changes. Trigram Dice similarity >=0.6 supplies at most three fallback candidates, ordered by similarity then tab/row; candidates never approve a match. Alias cycles, incomplete cell selections, missing anchors and unsupported import closures are withheld. Existing core parser/link/resolve/cells/reviewed suites test relocation, rank ranges, variants, category collisions, same-name ambiguity and broken overrides; the independent layout tests in `triageRules.test.ts` cover the changes in this round.

### Priority and maintenance

1. Preserve saved links, drafts and human statuses; apply explicit category/scope decisions, including permitted editor promotions.
2. Require current document scope/baseline; preserve current exact references and original 27 negatives.
3. Apply scoped investigations/optional priority, approved manifest-backed families, reviewed identity sets and the limited tentative negatives. A rejected source never becomes approved through a later fuzzy fallback.
4. Learned tabs, exact names and confirmed source cells may propose links; token/rename/fuzzy cases require confirmation. Unverified multipart and artifact identities remain for maintainers.

Physical cell decomposition and cooldown sharing do **not** establish item identity. Core's general combining utility is used only after category, owner/group or source-identity validation by the guided matcher; it explicitly rejects distinct artifact mechanics. The current-artifact list comes from the actual sheet section headers. Future source layouts are rediscovered by names/sections and cell evidence, not fixed row coordinates. Coordinates in generated tables are observed evidence only.

### Renamed saved links (2026-11-03)

`saved-link-content-relink`: after tab/name and relocated-name lookup fail, search logical descriptions across tracked tabs. Exactly one `sameCell` match with identical ordered multipart labels follows automatically as `moved`; multiple identical matches remain candidates. Run segmentation follows `sameCell`; styling and text must agree (no new whitespace folding).
A suggestion requires trigram Dice >=0.98 and a best/runner-up gap >=0.15. The suggested row is selected for explicit Confirm / Choose another; until confirmation it remains a repair, cannot mark reviewed, and blocks English saves. Confirmation creates a local draft with the new identity. Auto-link reports and the review queue retain the suggested row first among candidates; queue confirmation is explicit and suggestions never enter bulk acceptance. Ordered manual offsets are evaluated at each possible anchor; incomplete selections are excluded and configured descriptions never substitute for an override.
Calibration: `relink-calibration.test.ts` evaluates the 2026-10-30 reviewed-source and 2026-10-31 frozen-matcher sheets. No same-identity changed descriptions exist in their overlap; this is rename-simulation evidence, not observed rename precision. For 52 frozen current rows, punctuation, final-word deletion and numeric changes yield 155 rename-like cases plus 155 absent-identity negatives. Threshold sweep 0.85–0.98 / margin 0.05–0.15 had zero false suggestions; choose the strictest tested pair (0.98/0.15). Measured accepted-suggestion precision: 139/139 (100%); all 155 negatives withheld. The limited corpus does not establish live precision. Resolver, panel, queue and save-enricher tests cover identity/style/parts, duplicates, threshold/margin, cross-tab recovery, overrides and explicit confirmation.

### Shipped display approvals and computed cache (2026-11-04)

`approved-guidance.v1.json` is an immutable copy of the 117 references and frozen category
membership from the read-only 2026-11-02 audit input
`ccov-audit-42488/renewed-guidance.json`. It is an app asset, never editor-data, a saved link,
or a new approval. `guidanceSchema` validates it; the existing `rebaselineGuidance` validator
renews only unchanged entry/source evidence in memory. Meaningful local references/comments
layer over their recorded categories, retaining baseline, membership and unresolved-reference
gates. No owner browser or live guidance store is used to generate the shipped snapshot.
The pinned original is `C:/Users/Seleo/AppData/Local/Temp/ccov-audit-42488/renewed-guidance.json`
(SHA-256 `2cbb42830f8fbfcbb2304319f093358f4fafeae47da3cbf3ba599796fecadb86`).
The committed JSON has identical parsed content; formatting changes its file hash.
The audit editor/catalog input is `ccov-sol-high-20261102/inputs.json`; the refreshed audit
source is `.agents/reports/compendium-baseline/compendium-8602377.json` in the coordination checkout.

Both the pane and Matched sources tab consume the same read-only worker results. Only
`action=link` with `confidence=high` or the existing explicit out-of-scope parent-link exceptions
is displayed as Matched. The historical 2,067-link report includes 145 medium proposals:
its display-eligible population is 1,905 high + 17 explicit parent exceptions = 1,922.
Medium proposals remain proposals, never automatic pane matches. All four Collective entries
were already withheld in that report. Current live inputs can yield fewer links when frozen
membership or reference evidence no longer validates; the counts must not be conflated.

Regenerate `precomputed.v1.json` with `node scripts/compendium-guidance/precompute.mjs` after
any matching-rule/input change. The command reads public source/catalog/bundle plus shipped
approvals and writes only that app asset. Its SHA-256 key covers all catalog definitions, aliases, tooltip evidence and tracked styled
source tabs. Fetch/build timestamps, publication/account metadata and commit-only transport
changes are excluded for pristine display; local guidance additionally keys by the current commit
so stale baseline gates remain intact. Exact matches use the compact value table; changed inputs recompute
using the same matcher in a module worker. IndexedDB caches results by input hash and compiled
worker URL (including matcher code dependencies); blocked storage falls back to memory.
Reload published data creates a new source identity. View navigation shares the in-memory
session, so it neither parses the sheet nor restarts matching. Rich-cell interning/memoization
and sheet paint containment preserve text, spans, merged-cell selections, styling and colours.

Worker replies use the same value-table representation in one transferred UTF-8 buffer per
result stage, with independently readable packets of 128 nodes inside. This preserves
Map/undefined values, physical coordinates, full rich cells and structural sharing without a
burst of structured-clone messages. Decoding runs in background-priority slices (idle callbacks
where the scheduler API is unavailable) with a 2 ms budget, checks
pending discrete and continuous input, and yields inside large array/map/object nodes. The complete,
validated match map may publish before review metadata; partial review models never publish.
Callbacks are scoped to the editor, source, account, draft/link evidence, local guidance/progress
and request revision, so an older result cannot supply another context's automatic links.
Worker review replies carry English evidence only; the UI restores original tooltip/draft
identities and all translations from its authoritative editor store before any draft operation.
Optional IndexedDB writes do not delay delivery. Memory serves pending writes, and persistent
proposal caches retain their pristine display model as a pair, including on an immediate reload.
Draft matching projects only link/classification metadata, caches unchanged draft entries and
ignores live text; the review view overlays current draft English separately. Nearby sheet context
is built only after its existing disclosure is opened; the approved description stays immediate.
The generator also emits `precomputed.v1.json.gz`. Modern browsers fetch that 1.49 MB asset;
the worker handles both HTTP-decoded and raw gzip responses. Browsers without native gzip
decompression retain the JSON fallback. Review models are prepared across all entries in
separate idle jobs, without using a selected route or predicted navigation sequence.
Closed source-picker content retains its selections but stops reconciling entry changes;
hidden visited sheets are memoized. Linked/unlinked lists render 100 entries at a time with
an explicit continuation, rather than laying out thousands of invisible rows on first opening.
The worker retains complete grids for matching and validation. Proposal/display replies carry
compact tab metadata because the UI already owns the grid; confirmation still resolves every
selected cell against that original source before creating a draft.

The source loader and matcher now share one retained worker. It fetches, parses and validates
the source once; that source is never cloned back into another matching worker. Editor input
is serialized in bounded, yielding UTF-8 chunks and its ArrayBuffers are transferred. An
editor reload replaces the initialized editor while retaining the worker's source. Unchanged
focus/storage events compare stored content before parsing, and selection-only/empty guidance
metadata changes do not invalidate matching. Same-window guidance/decision writes notify the
shared input store; actual changes still withhold old matches until validation completes.

Opening or navigating the review page derives its guidance category scaffold and baseline
renewal in memory. It never persists approval data, including an empty guidance scope, or
replays pending approval saves merely because the page mounted. Decisions, comments, imports,
explicit retries, and Send to agents authorize a persistence snapshot. Later derived changes
cannot alter that snapshot during an autosave acknowledgement or route teardown. The first
explicit edit after renewal backs up the original stored bytes before replacing them; a failed
backup leaves those original bytes intact. Queue selection, query, category, and filter are
view state: unchanged values are skipped, writes coalesce at idle, and pagehide flushes them.

Approval actions occupy normal layout space. The desktop entry footer has its own flex row;
phone entry actions and sample actions follow their content. They never float over inspection
links, disclosures, or other controls. The layout no longer measures action bars on mount.

<!-- BEGIN GENERATED OWNER DECISIONS -->
## Maintainer decisions and exceptions (generated)

Source: finalized `owner-triage.json` (2026-11-02), not superseded chronological proposals. The original 27 guided negatives are preserved. Run `node scripts/compendium-guidance/matching-rules.mjs` after changing authoritative data.

### Final triage — every member

| Hash | Item | Original category | Decision / group | Date/source |
|---|---|---|---|---|
| 1279785143 | Accelerated Coils | catalog:weapon-perk | effect; attachment-source-investigation; group 1 | 2026-11-02, finalized triage |
| 580685494 | Auxiliary Reserves | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2719770986 | Auxiliary Reserves | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 52780822 | Balanced Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2338887882 | Balanced Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1263609309 | Ballistic Tuning | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2154730217 | Ballistic Tuning | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3625355092 | Burst Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3732622839 | Burst Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3923000764 | Burst Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2467967826 | Chambered Compensator | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3399528164 | Chambered Compensator | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3661387068 | Chambered Compensator | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 16392701 | Compact Arrow Shaft | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2732340361 | Compact Arrow Shaft | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1844523823 | Confined Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3471392239 | Confined Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 111235976 | Corkscrew Rifling | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4090651448 | Corkscrew Rifling | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2052299741 | Countermass | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3809316345 | Countermass | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2801223209 | Elastic String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3956406253 | Elastic String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2398680997 | Empowered Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4196967425 | Empowered Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1261178282 | Enduring Blade | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3885243590 | Enduring Blade | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 599007201 | Enduring Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1180618054 | Enduring Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4267445637 | Enduring Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1080094173 | Enhanced Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2126519017 | Enhanced Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1467527085 | Extended Barrel | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1932356121 | Extended Barrel | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 52802868 | Fiberglass Arrow Shaft | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3429800428 | Fiberglass Arrow Shaft | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1777340333 | Flexible String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4067834857 | Flexible String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2953575380 | Frictionless Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3786062476 | Frictionless Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 564443854 | Hard Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 981914802 | Hard Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2349202967 | Heavy Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3653484343 | Heavy Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1796628141 | Helical Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3311977193 | Helical Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3371775011 | High Tension String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4185607275 | High Tension String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2827049491 | Honed Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4270598587 | Honed Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 436053704 | Hungry Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1498024248 | Hungry Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2363751990 | Infinite Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4088159466 | Infinite Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 807993149 | Ionized Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1454612425 | Ionized Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3666208348 | Jagged Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3959569796 | Jagged Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1946186791 | Light Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4273542183 | Light Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 594346985 | Lightweight Emitter | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2364577709 | Lightweight Emitter | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1441682018 | Linear Compensator | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1639399262 | Linear Compensator | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2777563320 | Liquid Coils | catalog:weapon-perk | effect; attachment-source-investigation; group 1 | 2026-11-02, finalized triage |
| 2713678205 | Low-Impedance Windings | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3355117577 | Low-Impedance Windings | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 234526563 | Low-Profile Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1890040155 | Low-Profile Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1776069409 | Mag-lev Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2385083333 | Mag-lev Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1500996326 | Natural Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3819272442 | Natural Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1301083363 | Natural String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1784898267 | Natural String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 852209214 | Polymer String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3837163218 | Polymer String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3250572790 | Quick Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3525010810 | Quick Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3128149872 | Quickload Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 4088731040 | Quickload Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 582768348 | Smart Drift Control | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3798852852 | Smart Drift Control | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1649480699 | Straight Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3827198035 | Straight Fletching | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 125241418 | Swordmaster's Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 269888150 | Swordmaster's Guard | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 769709866 | Tactical Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 3210123846 | Tactical Heatsink | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1196733167 | Tactile String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 2276384431 | Tactile String | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 766579919 | Tempered Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 938542991 | Tempered Edge | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1220787353 | Ultralight Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1465283453 | Ultralight Rail | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 373417387 | Volatile Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1478423395 | Volatile Launch | catalog:weapon-perk | attachment; weapon-attachment; group 1 | 2026-11-02, finalized triage |
| 1065371964 | Appended Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1087426260 | Appended Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1996142143 | Black Powder | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3605260959 | Black Powder | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1890997540 | Extended Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 2420895100 | Extended Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1709045111 | Flared Magwell | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3230963543 | Flared Magwell | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1380253176 | High-Explosive Ordnance | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3781548872 | High-Explosive Ordnance | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 2108812838 | High-Velocity Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 2822142346 | High-Velocity Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3492396210 | Implosion Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3807404750 | Implosion Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 679225683 | Light Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1807273211 | Light Mag | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 332133599 | Mini Frags | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3156458303 | Mini Frags | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1002206008 | Steady Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 3177308360 | Steady Rounds | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 1802305063 | Thermoplastic Grenades | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 2870095399 | Thermoplastic Grenades | catalog:weapon-perk | attachment; weapon-attachment; group 2 | 2026-11-02, finalized triage |
| 911046886 | Aquila SS4 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 893526895 | ATD Raptor | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 1716000303 | Concussion Grenades | catalog:weapon-perk | effect; attachment-source-investigation; group 3 | 2026-11-02, finalized triage |
| 2406549743 | Concussion Grenades | catalog:weapon-perk | effect; attachment-source-investigation; group 3 | 2026-11-02, finalized triage |
| 911046887 | Corvo SS2 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 3720500948 | Enhanced Heat Generated | catalog:weapon-perk | weapon-mod-excluded; weapon-mod-stat; group 3 | 2026-11-02, finalized triage |
| 1455043575 | Enhanced Vent Speed | catalog:weapon-perk | weapon-mod-excluded; weapon-mod-stat; group 3 | 2026-11-02, finalized triage |
| 1628165637 | Flash HS5 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 194952922 | Impulse MS3 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 1313805251 | LD Watchdog | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 3433396027 | Meyrin RDL | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 137682932 | Proximity Grenades | catalog:weapon-perk | effect; attachment-source-investigation; group 3 | 2026-11-02, finalized triage |
| 409831596 | Proximity Grenades | catalog:weapon-perk | effect; attachment-source-investigation; group 3 | 2026-11-02, finalized triage |
| 3999527219 | Remote Detonation | catalog:weapon-perk | effect-tentative; attachment-source-investigation; group 3 | 2026-11-02, finalized triage |
| 2414725840 | Satou Focus Lens | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 2054312701 | SD Thermal | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 194952923 | Signal MS5 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 3151536501 | SPO-57 Front | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 360593482 | SRO-41 Ocular | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 1617987574 | SSO-05 Sniper | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 1617987575 | SSO-07 Sniper | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 194952921 | Transmission MS7 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 911046885 | Yepaki SS2 | catalog:weapon-perk | attachment; weapon-attachment; group 3 | 2026-11-02, finalized triage |
| 1529576681 | Combat Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3438534621 | Combat Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 290984395 | Composite Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3465198467 | Composite Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 155346308 | Fitted Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 4259401308 | Fitted Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 990298390 | Hand-Laid Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3845057226 | Hand-Laid Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 223754954 | Heavy Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 1012699414 | Heavy Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 862848869 | Polymer Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 2078097559 | Polymer Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3358678417 | Polymer Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 1067908860 | Short-Action Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 2913786532 | Short-Action Stock | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 197518367 | Smooth Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3326204863 | Smooth Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3917450714 | Textured Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 4039411798 | Textured Grip | catalog:weapon-perk | attachment; weapon-attachment; group 4 | 2026-11-02, finalized triage |
| 3176795734 | Calm Amidst Chaos | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3481749002 | Calm Amidst Chaos | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3176795733 | Kill Shot | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 4043176609 | Kill Shot | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3176795729 | Overpressured Munitions | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3890581141 | Overpressured Munitions | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3176795732 | Stay in the Fight | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3804466364 | Stay in the Fight | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3647810002 | Temporal Adapter | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3734826478 | Temporal Adapter | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 941476219 | Temporal Armaments | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3647810003 | Temporal Armaments | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3261189180 | Temporal Blast | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3647810004 | Temporal Blast | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3356720704 | Temporal Loader | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3647810000 | Temporal Loader | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3347303957 | Temporal Tracker | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 3647810001 | Temporal Tracker | catalog:weapon-perk | inactive; inactive-placeholder; group 5 | 2026-11-02, finalized triage |
| 890263315 | Balanced Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1237488985 | Balanced Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2628485818 | Balanced Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3686638441 | Balanced Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 4154539171 | Balanced Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 890263312 | Burst Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1237488986 | Burst Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2628485817 | Burst Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3686638442 | Burst Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 4154539168 | Burst Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 266130437 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 469281042 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1380268164 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1698387812 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2225231094 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3350493951 | Catapult Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 266130439 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 469281040 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1380268166 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1698387814 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2225231092 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3350493949 | High Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 890263313 | Strafe Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1237488987 | Strafe Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2628485816 | Strafe Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3686638443 | Strafe Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 4154539169 | Strafe Glide | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 266130438 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 469281041 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1380268167 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 1698387815 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 2225231093 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 3350493948 | Strafe Lift | catalog:subclass-movement | optional; optional-movement; group 6 | 2026-11-02, finalized triage |
| 20616658 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 95544330 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1128768654 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1588878499 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3531427694 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3721022587 | High Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 20616659 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 95544331 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1128768655 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1588878498 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3531427695 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3721022586 | Strafe Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 95544328 | Triple Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1128768652 | Triple Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 1588878497 | Triple Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3531427692 | Triple Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 3721022585 | Triple Jump | catalog:subclass-movement | optional; optional-movement; group 7 | 2026-11-02, finalized triage |
| 95544329 | Blink | catalog:subclass-movement | optional; optional-movement; group 8 | 2026-11-02, finalized triage |
| 1237488984 | Blink | catalog:subclass-movement | optional; optional-movement; group 8 | 2026-11-02, finalized triage |
| 1588878496 | Blink | catalog:subclass-movement | optional; optional-movement; group 8 | 2026-11-02, finalized triage |
| 3122197216 | Balanced Tuning | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 4204488676 | Class Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 1435557120 | Grenade Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 1180408010 | Health Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 4287799666 | Melee Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 1237786518 | Minor Class Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 4021790309 | Minor Grenade Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 2532323436 | Minor Health Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 2639422088 | Minor Melee Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 350061697 | Minor Super Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 1703647492 | Minor Weapons Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 2724608735 | Super Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 4183296050 | Weapons Mod | catalog:armor-mod-general | armor-stat; manifest-armor-stat; group 9 | 2026-11-02, finalized triage |
| 2778559527 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3514869240 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3514869241 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3514869243 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3565742161 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3565742162 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3565742163 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3641619157 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3899519180 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3899519181 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 3899519183 | Locked Armor Mod | catalog:armor-mod-general | inactive; inactive-placeholder; group 10 | 2026-11-02, finalized triage |
| 2077016094 | Arc/Stasis Dual Siphon | catalog:armor-mod-general | siphon; armor-siphon-family; group 11 | 2026-11-02, finalized triage |
| 2733010662 | Kinetic Charge Siphon | catalog:armor-mod-general | siphon; armor-siphon-family; group 11 | 2026-11-02, finalized triage |
| 1433540272 | Kinetic Entropy Siphon | catalog:armor-mod-general | siphon; armor-siphon-family; group 11 | 2026-11-02, finalized triage |
| 2734970071 | Kinetic Thermal Siphon | catalog:armor-mod-general | siphon; armor-siphon-family; group 11 | 2026-11-02, finalized triage |
| 2824493179 | Set Bonus:  / Accretion | catalog:armor-mod-general | irrelevant; irrelevant-selector; group 11 | 2026-11-02, finalized triage |
| 1530138662 | Set Bonus:  / Wayward Psyche | catalog:armor-mod-general | irrelevant; irrelevant-selector; group 11 | 2026-11-02, finalized triage |
| 3458160468 | Void/Stasis Dual Siphon | catalog:armor-mod-general | siphon; armor-siphon-family; group 11 | 2026-11-02, finalized triage |
| 3619040076 | Elemental Siphon | catalog:armor-mod-seasonal | distinct-artifact; artifact-identity-unresolved; group 12 | 2026-11-02, finalized triage |
| 519046634 | Caster Frame | catalog:weapon-perk-exotic | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 2557881346 | Vortex Frame | catalog:weapon-perk-exotic | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 289811733 | Wave Sword Frame | catalog:weapon-perk-exotic | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 1726251414 | Aggressive Frame | catalog:weapon-trait-exotic | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 1986105578 | Aggressive Glaive | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 2571259936 | Compressed Wave Frame | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 1546108491 | Disruption Weapon [Shield-Piercing] | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 3572001649 | High-Impact Longbow | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 2928496916 | Micro-Missile Frame | catalog:weapon-frame | combined; owner-verified-multirow; group 13 | 2026-11-02, finalized triage |
| 407573255 | Rapid Fire Slug | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 1956005708 | Rapid-Fire Glaive | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 430173891 | Wave Sword Frame | catalog:weapon-frame | no-equivalent; owner-tentative-no-equivalent; group 13 | 2026-11-02, finalized triage |
| 1891050213 | Darkness Buffs | catalog:verbs | no-equivalent; owner-tentative-no-equivalent; group 14 | 2026-11-02, finalized triage |
| 2713325501 | Light Buffs | catalog:verbs | no-equivalent; owner-tentative-no-equivalent; group 14 | 2026-11-02, finalized triage |
| 3023190802 | Light Debuffs | catalog:verbs | no-equivalent; owner-tentative-no-equivalent; group 14 | 2026-11-02, finalized triage |
| 1791833453 | Extract Pattern | catalog:weapon-mod | irrelevant; irrelevant-extractor; group 15 | 2026-11-02, finalized triage |
| 2747500761 | Hammer of Sol | catalog:subclass-super | combined; owner-verified-multirow; group 15 | 2026-11-02, finalized triage |
| 1377143502 | Slicewire Grenade | catalog:subclass-grenade | combined; owner-verified-cell; group 15 | 2026-11-02, finalized triage |

### Earlier explicit parent/exclusion exceptions

| Hash | Item | Decision | Date/source |
|---|---|---|---|
| 185041502 | Volatile Battery | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 265542500 | Chain Bowstring | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 332773068 | Volatile Launch | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 697983358 | Offensive Grip | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 1127992351 | Unyielding Handle | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 1408087974 | Combat Sights | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 1408087975 | Marksman Sights | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 1958555234 | Balanced Grip | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 1992361643 | Anti-Taken Fletching | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 2005566727 | Nucleosynthetic Magazine | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 2931483505 | Default Ornament | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3295115440 | Defensive Grip | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3377448506 | Tenacious Handle | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3492498209 | Shortened Barrel | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3514694513 | Balanced Tang | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3553394349 | Rampager's Handle | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3794918801 | Fencing Tang | Parent exotic link retained; stat-only tooltip exclusion; exact hash/name/category exception, never a general parent-only promotion | 2026-11-02, ROOT decision 3 |
| 3619040074 | Expert Handling | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 3619040075 | Gravitic-Voltaic Charge | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 3619040077 | Fastest Draw | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 3619040078 | Vanguard Surplus Discounts | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 3619040079 | Concentrated Forward Firepower | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417017 | Anti-Barrier Hand Cannon | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417018 | Anti-Barrier Sniper Rifle | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417019 | Overload Pulse Rifle | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417020 | Overload Submachine Gun | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417021 | Unstoppable Bow | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417022 | Stunning Fusion | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |
| 4217417023 | Shield-Shattering Rounds | Excluded only while no current parent/named source; reason: not in a current artifact | 2026-11-02, ROOT decision 1 |

### Tentative no-equivalent decisions

Only the original named decision-7 set (superseded Coils investigations removed) and explicit finalized triage negatives remain below. A changed full-sheet or entry fingerprint reopens them; no absence/blank-text inference.

| Hash | Item | Rule ID | Date/source |
|---|---|---|---|
| 2557881346 | Vortex Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1316753551 | Adaptive Glaive | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 918679156 | Pinpoint Slug Frame | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 263649945 | Vortex Frame | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 1395789926 | Wave Frame | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 117884138 | Adept Accuracy | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 229003538 | Adept Blast Radius | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 744770875 | Adept Charge Time | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 1885045197 | Adept Draw Time | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 4278960718 | Adept Handling | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 3208647503 | Adept Impact | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 1225726778 | Adept Mag | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 634781242 | Adept Reload | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 4003264426 | Adept Stability | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 1710791394 | Adept Targeting | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 3564974257 | Full Auto Retrofit | owner-tentative-no-equivalent | 2026-11-02, ROOT decision 7, explicitly named item |
| 519046634 | Caster Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 289811733 | Wave Sword Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1726251414 | Aggressive Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1986105578 | Aggressive Glaive | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 2571259936 | Compressed Wave Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1546108491 | Disruption Weapon [Shield-Piercing] | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 3572001649 | High-Impact Longbow | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 407573255 | Rapid Fire Slug | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1956005708 | Rapid-Fire Glaive | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 430173891 | Wave Sword Frame | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 1891050213 | Darkness Buffs | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 2713325501 | Light Buffs | owner-tentative-no-equivalent | 2026-11-02, finalized triage |
| 3023190802 | Light Debuffs | owner-tentative-no-equivalent | 2026-11-02, finalized triage |

### Individually reviewed item/group-specific source rules

| Hash | Item | Source/group definition | Decision/evidence | Date/source |
|---|---|---|---|---|
| 216781713 | Precision Frame | gid 1662574278; Precision Frame (observed r333c0); Precision Frame / (Rocket Launchers) (observed r334c0); Precision Frame  / (Hand Cannon) (observed r335c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 570373697 | Heavy Burst | gid 1662574278; Heavy Burst (observed r324c0); Heavy Burst / (Hand Cannon) (observed r325c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 806997698 | Rapid-Fire Frame | gid 1662574278; Rapid-Fire Frame (observed r336c0); Rapid-Fire Frame / (Shotguns) (observed r337c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 836583820 | Aggressive Frame | gid 1662574278; Aggressive Frame (observed r315c0); Aggressive Frame / (Fusion Rifles) (observed r316c0); Aggressive Frame / (Rocket Launchers) (observed r317c0); Aggressive Frame / (Scout Rifles) (observed r318c0); Aggressive Frame / (Shotguns) (observed r319c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1019291327 | High-Impact Frame | gid 1662574278; High-Impact Frame (observed r326c0); High-Impact Frame / (Rocket Launchers) (observed r327c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1293395730 | Lightning Surge | gid 618967225; Lightning Surge (observed r136c1) | owner-verified-cell: Sliding melee warps forward and calls five jolting lightning bolts.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1294026524 | Adaptive Frame | gid 1662574278; Adaptive Frame (observed r312c0); Adaptive Frame / (Rocket Launchers) (observed r313c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1377143502 | Slicewire Grenade | gid 1870531554; Slicewire (observed r39c1) | owner-verified-cell: Bouncing Strand grenade delivers four splash hits and inflicts Sever.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1656549672 | Touch of Thunder | gid 618967225; Touch of Thunder (observed r36c1); Touch of Thunder (observed r41c1); Touch of Thunder (observed r44c1); Touch of Thunder (observed r49c1); Touch of Thunder (observed r110c1) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1656549674 | Knockout | gid 618967225; Knockout (observed r106c1) | owner-verified-cell: Melee kills heal/amplify; shield break or low-health damage activates Knockout melee bonuses.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 1860418166 | Blastwave Striders | gid 1500097863; Blastwave Striders (observed r28c3); Blastwave Striders (observed r30c3) | exotic-armor-card: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2321824285 | Chaos Accelerant | gid 1907852650; Chaos Accelerant / (Charged) (observed r36c1); Chaos Accelerant / (Charged) (observed r43c1); Chaos Accelerant / (Charged) (observed r52c1); Chaos Accelerant (observed r133c1) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2642597904 | Bleak Watcher | gid 1088259962; Bleak Watcher (observed r103c1) | owner-verified-cell: Held grenade converts to a Stasis turret firing slowing bursts; Glacier cooldown scalar.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2747500761 | Hammer of Sol | gid 1186062409; Hammer of Sol (observed r105c1); Hammer of Sol / (Sol Invictus Aspect) (observed r107c1) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2800865663 | Swarmers | gid 1500097863; Swarmers (observed r121c6); Swarmers (observed r123c6) | exotic-armor-card: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2928496916 | Micro-Missile Frame | gid 1662574278; Micro-Missile Frame / (Special Grenade Launchers) (observed r330c0); Micro-Missile Frame / (Pulse Rifles and Sidearms) (observed r331c0) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 2934767477 | Winter's Shroud | gid 1088259962; Winter's Shroud (observed r65c1) | owner-verified-cell: Class ability slows nearby enemies; inflicting slow boosts class regeneration.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 3866705246 | Diamond Lance | gid 1088259962; Diamond Lance (observed r83c1) | owner-verified-cell: Stasis kills create a pickup lance, with thrown/slam freeze effects and spawn cooldown.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 4184589900 | Touch of Winter | gid 1088259962; Touch of Winter (observed r34c1); Touch of Winter (observed r37c1); Touch of Winter (observed r40c1); Touch of Winter (observed r43c1); Touch of Winter (observed r63c1) | owner-verified-multirow: All named rows are variants/effects of this item; qualifiers identify weapon types, grenade modifications or the same physical exotic armour card.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |
| 4194622039 | Ascension | gid 618967225; Ascension (observed r72c1) | owner-verified-cell: Airborne Arc Staff twirl consumes class charge, amplifies allies and jolts nearby enemies.; complete styled row-set evidence, relocation allowed, new/changed members withheld | 2026-11-02, ROOT pass3/follow-up cell review |

### Original guided no-equivalent population (unchanged)

- 910975608: Embraced Largesse — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 3432568518: Empowering Largesse — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 2426323900: Energized — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 3420505819: Giving Hand — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 1544361296: Heavy Hitter — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 952444125: Radiant Largesse — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 843081753: Shielding Hand — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 439168247: Striking Hand — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 3619040072: Impact, Shock, Gravity — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 91797879: Version: Alpha — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 91797878: Version: One — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 91797877: Version: Prime — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 935202422: Horizon Ironsights — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 299264772: Adept Range — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 2483028032: Chaotic Motion — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 2483028035: Fikrul's Friends — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 1285109625: Jumpshot — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 2483028033: Overflowing Holster — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 231101171: Random Masterwork — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 1285109627: Shattershafts — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 1285109626: Tungsten Bowstring — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 5333294: Balanced Glide — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 5333295: Blink — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 5333293: Burst Glide — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 5333292: Strafe Glide — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 20616656: Triple Jump — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.
- 1514833946: Darkness Debuffs — original guided no-equivalent; pre-2026-11-02 owner guidance, preserved by ROOT clarification 2026-11-02.

### Guided reference snapshot

Frozen baseline: 100d9e645f71c3edf343b45dcf2e74395e7b724f|8012327:1670865501. Runtime references additionally require current membership, baseline and entry/source evidence. A stale/skipped/note-only reference does not approve a mapping.

| Hash | Item/category | Decision/source | Note | Date |
|---|---|---|---|---|
| 8507332 | Chaotic Exchanger / catalog:armor-trait-exotic | accepted; gid 1500097863, Chaotic Exchanger, Armor; cells []; parts [] |  | 2026-11-01T08:55:04.903Z |
| 117669763 | The Dance / catalog:armor-trait-exotic | accepted; gid 1500097863, The Dance, Armor; cells []; parts [] |  | 2026-11-01T08:56:58.607Z |
| 236605015 | Vanishing Execution / catalog:armor-trait-exotic | accepted; gid 1500097863, Vanishing Execution, Armor; cells []; parts [] |  | 2026-11-01T08:56:19.601Z |
| 481860150 | Wish-Dragon Teeth / catalog:armor-trait-exotic | accepted; gid 1500097863, Wish-Dragon Teeth, Armor; cells []; parts [] |  | 2026-11-01T08:56:40.571Z |
| 578605621 | Praxic Lift / catalog:armor-trait-exotic | accepted; gid 1500097863, Praxic Lift, Armor; cells []; parts [] |  | 2026-11-01T08:55:41.691Z |
| 644105 | Heavy Ammo Finder / catalog:armor-mod-general | accepted; gid 1934379638, Ammo Finder / [3 Energy], Helmet; cells []; parts [] | Cell is shared by both types of finder mods. This is completely fine. | 2026-11-01T08:58:05.278Z |
| 11126525 | Powerful Attraction / catalog:armor-mod-general | accepted; gid 1934379638, Powerful Attraction / [2 Energy], Class Item; cells []; parts [] |  | 2026-11-01T09:02:13.020Z |
| 14520248 | Kinetic Weapon Surge / catalog:armor-mod-general | accepted; gid 1934379638, Weapon Surge / [3 Energy], Legs; cells []; parts [] | This cell is shared by all weapon surge mods, this is completely fine. | 2026-11-01T09:01:36.027Z |
| 309000506 | +Grenade / -Melee / catalog:armor-mod-general | no-equivalent | We generally don't attach tooltips to mods that go in the first slot of armour pieces or into an artifice mod slot. The Compendium approaches it the same way so these kinds of mods will not be found there. All that needs to be known about these mods is provided by the API (usually investmentStat property that partner apps simply display). | 2026-11-01T09:01:00.448Z |
| 2527938402 | Riven's Curse / catalog:armor-mod-general | accepted; gid 1934379638, Riven's Curse, Activity or Destination Specific; cells []; parts [] |  | 2026-11-01T09:02:31.643Z |
| 399528760 | Taken Invigoration / catalog:armor-mod-activity | accepted; gid 1934379638, Taken Invigoration, Raid Specific; cells []; parts [] |  | 2026-11-01T09:03:24.092Z |
| 518521232 | Precise Oracle Disruptor / catalog:armor-mod-activity | accepted; gid 1934379638, Precise Oracle Disruptor, Raid Specific; cells []; parts [] |  | 2026-11-01T09:09:00.404Z |
| 539051925 | Chill Out / catalog:armor-mod-activity | accepted; gid 1934379638, Chill Out, Raid-Specific; cells []; parts [] |  | 2026-11-01T09:08:50.932Z |
| 1389309840 | Precise Jolts / catalog:armor-mod-activity | picked; gid 1934379638, Precise Jolt, Raid-Specific; cells [{"dRow":0,"dCol":2}]; parts [] | Small typos in the Compendium should not lead to an inability to match. | 2026-11-01T09:07:35.538Z |
| 1560574695 | Nightmare Breaker / catalog:armor-mod-activity | accepted; gid 1934379638, Nightmare Breaker / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells []; parts [] |  | 2026-11-01T09:08:39.651Z |
| 2742146816 | Sword Storm Combo / catalog:armor-mod-seasonal | accepted; gid 473308249, Sword Storm Combo, Encrypted Data Disk (Renegades); cells []; parts [] |  | 2026-11-01T09:09:59.683Z |
| 2742146817 | Void Infestation / catalog:armor-mod-seasonal | accepted; gid 473308249, Void Infestation, Encrypted Data Disk (Renegades); cells []; parts [] |  | 2026-11-01T09:16:39.515Z |
| 2742146818 | Tazer Tag / catalog:armor-mod-seasonal | accepted; gid 473308249, Tazer Tag, Encrypted Data Disk (Renegades); cells []; parts [] |  | 2026-11-01T09:16:55.314Z |
| 3619040072 | Impact, Shock, Gravity / catalog:armor-mod-seasonal | no-equivalent | This is an artifact perk that has been sunset (its match is in an OLD sheet). Only the current artifact sheet's perks should get matched. | 2026-11-01T09:12:39.299Z |
| 3619040076 | Elemental Siphon / catalog:armor-mod-seasonal | skipped | There are two perks with this name in the artifact sheet under two different artifacts. You should have a way to distinguish between which artifact a perk belongs to and search in the sheet based on that. | 2026-11-01T09:16:26.949Z |
| 5699512 | Tempered Truss Rod / catalog:weapon-perk | no-equivalent | Most perks in the first two columns of weapon perks do not need a description as their behaviour is entirely explained by the API-providex investmentStat info. | 2026-11-01T09:18:34.830Z |
| 54024075 | Veist Stinger / catalog:weapon-perk | accepted; gid 1662574278, Veist Stinger /  / Veist / Foundry, Origin Traits; cells []; parts [] |  | 2026-11-01T09:19:06.125Z |
| 81592656 | Enhanced Impact / catalog:weapon-perk | accepted; gid 1662574278, Enhanced Impact, Enhanced Weapon Mods are equippable only on Tier 4 and Tier 5 Weapons.; cells []; parts [] |  | 2026-11-01T09:19:27.131Z |
| 226831738 | Overclocked Heatsink / catalog:weapon-perk | accepted; gid 1662574278, Overclocked Heatsink, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:19:55.264Z |
| 988031486 | Photoinhibition / catalog:weapon-perk | accepted; gid 1662574278, Photoinhibition /  / Garden of Salvation / Raid, Origin Traits; cells []; parts [] |  | 2026-11-01T09:20:22.373Z |
| 91797877 | Version: Prime / catalog:weapon-perk-exotic | no-equivalent | We don't attach tooltips to fucking ornaments. | 2026-11-01T09:20:49.968Z |
| 505341189 | Modified Heatsink / catalog:weapon-perk-exotic | accepted; gid 441434520, Third Iteration /  / Tri-Planar Mass / Modified Heatsink / Amalgamation Rounds / ↑Aberrant Combustion, Energy Slot Weapons; cells []; parts [] |  | 2026-11-01T09:21:17.221Z |
| 1980732122 | Blades of Unmaking / catalog:weapon-perk-exotic | accepted; gid 441434520, Cull's Shadow /  / Soulburn / Soulforge / Blades of Unmaking / ↑Selectable Trait, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:25:54.400Z |
| 2753228730 | Lightweight Frame / catalog:weapon-perk-exotic | accepted; gid 1662574278, Lightweight Frame, Intrinsic Traits; cells []; parts [] |  | 2026-11-01T09:26:05.248Z |
| 4026309323 | Deflection Tang / catalog:weapon-perk-exotic | picked; gid 441434520, Praxic Blade / Technically-Not-A-Lightsaber /  / Ranged Weapon / Cormorant Reversal / Cormorant Combo, Kinetic Slot Weapons; cells [{"dRow":0,"dCol":3}]; parts [] |  | 2026-11-01T09:25:26.264Z |
| 11551321 | Iron Grip / catalog:weapon-trait | accepted; gid 1662574278, Iron Grip, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:26:29.536Z |
| 31345821 | Sword Logic / catalog:weapon-trait | accepted; gid 1662574278, Sword Logic, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:26:36.837Z |
| 1164602481 | Deconstruct / catalog:weapon-trait | accepted; gid 1662574278, Deconstruct, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:26:32.855Z |
| 1546142478 | Binary Orbit / catalog:weapon-trait | accepted; gid 1662574278, Binary Orbit, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:26:41.857Z |
| 3425386926 | Rampage / catalog:weapon-trait | accepted; gid 1662574278, Rampage, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:26:44.801Z |
| 4620383 | Weft Cutter / catalog:weapon-trait-exotic | accepted; gid 441434520, The Navigator /  / Protective Weave / Weft Cutter / ↑Gordian Knot, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:26:52.218Z |
| 501717180 | Ionic Return / catalog:weapon-trait-exotic | accepted; gid 441434520, Borealis /  / The Fundamentals  / Ionic Return / ↑Shield Disorient, Energy Slot Weapons; cells []; parts [] |  | 2026-11-01T09:28:57.044Z |
| 935202422 | Horizon Ironsights / catalog:weapon-trait-exotic | no-equivalent | Once again, most perks in the first two columns don't need tooltips. | 2026-11-01T09:28:45.140Z |
| 1281243303 | Adaptive Ordnance / catalog:weapon-trait-exotic | accepted; gid 441434520, Eyes of Tomorrow /  / Eyes on All / Adaptive Ordnance / ↑Blast Distributor / ↑Demolitionist, Power Weapons; cells []; parts [] |  | 2026-11-01T09:28:49.589Z |
| 2620589274 | The Fundamentals / catalog:weapon-trait-exotic | skipped | You could technically link this to every exotic it's present on but it's really only the reload hold to swap elements part so it's not that deep. | 2026-11-01T09:28:10.389Z |
| 19542588 | Nano-Munitions / catalog:weapon-trait-origin | accepted; gid 1662574278, Nano-Munitions /  / Season of the Wish / Undying Reprises, Origin Traits; cells []; parts [] |  | 2026-11-01T09:29:18.902Z |
| 59871045 | Gravity Well / catalog:weapon-trait-origin | accepted; gid 1662574278, Gravity Well /  / Rites of the Nine, Origin Traits; cells []; parts [] |  | 2026-11-01T09:29:24.432Z |
| 65797256 | Fleet Footed / catalog:weapon-trait-origin | accepted; gid 1662574278, Fleet Footed /  / Trials of Osiris / Ritual, Origin Traits; cells []; parts [] |  | 2026-11-01T09:29:55.735Z |
| 79448657 | Psychohack / catalog:weapon-trait-origin | accepted; gid 1662574278, Psychohack /  / Throne World / Destination, Origin Traits; cells []; parts [] |  | 2026-11-01T09:29:26.546Z |
| 270582335 | Noble Deeds / catalog:weapon-trait-origin | accepted; gid 1662574278, Noble Deeds /  / Season of Defiance, Origin Traits; cells []; parts [] |  | 2026-11-01T09:29:21.680Z |
| 2206869417 | Häkke Heavy Burst Fire / catalog:weapon-perk-exotic | picked; gid 441434520, Revision Zero /  / Hunter's Trace I–IV / Craftable Trait / Burst Mode / ↑Craftable Refit, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:30:25.344Z |
| 4152458172 | Häkke Light Burst Fire / catalog:weapon-perk-exotic | picked; gid 441434520, Revision Zero /  / Hunter's Trace I–IV / Craftable Trait / Burst Mode / ↑Craftable Refit, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:30:38.810Z |
| 23371658 | Box Breathing / catalog:weapon-trait-enhanced | accepted; gid 1662574278, Box Breathing, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:30:52.109Z |
| 65604327 | Supercharged Magazine / catalog:weapon-trait-enhanced | accepted; gid 1662574278, Supercharged Magazine, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:30:58.151Z |
| 102912326 | Hatchling / catalog:weapon-trait-enhanced | accepted; gid 1662574278, Hatchling, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:31:00.385Z |
| 288411554 | Rampage / catalog:weapon-trait-enhanced | accepted; gid 1662574278, Rampage, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:31:05.467Z |
| 2649013855 | Full Auto Trigger System / catalog:weapon-trait-enhanced | accepted; gid 1662574278, Full Auto Trigger System, Weapon Traits; cells []; parts [] |  | 2026-11-01T09:30:54.188Z |
| 31057037 | Adaptive Burst / catalog:weapon-frame | accepted; gid 1662574278, Adaptive Burst, Intrinsic Traits; cells []; parts [] |  | 2026-11-01T09:31:11.959Z |
| 183772609 | Caster Frame / catalog:weapon-frame | skipped |  | 2026-11-01T09:31:59.265Z |
| 244760020 | Area Denial Frame / catalog:weapon-frame | accepted; gid 1662574278, Area Denial Frame, Intrinsic Traits; cells []; parts [] |  | 2026-11-01T09:31:47.864Z |
| 407573255 | Rapid Fire Slug / catalog:weapon-frame | skipped |  | 2026-11-01T09:31:41.566Z |
| 1002219198 | Balanced Heat Weapon / catalog:weapon-frame | accepted; gid 1662574278, Balanced Heat Weapon, Intrinsic Traits; cells []; parts [] |  | 2026-11-01T09:32:04.552Z |
| 34498892 | The Right Choice / catalog:weapon-frame-exotic | accepted; gid 441434520, Khvostov 7G-0X /  / The Right Choice / Eyes Up, Guardian / Shoot to Loot / ↑Attrition Orbs, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:32:13.946Z |
| 281315705 | White Nail / catalog:weapon-frame-exotic | accepted; gid 441434520, Whisper of the Worm /  / White Nail / Craftable Trait / ↑Whispered Breathing, Power Weapons; cells []; parts [] |  | 2026-11-01T09:33:30.950Z |
| 975429949 | Gathering Light / catalog:weapon-frame-exotic | accepted; gid 441434520, Traveler's Chosen /  / Gathering Light / Gift of the Traveler / ↑Osmosis / ↑Surplus, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:33:24.303Z |
| 2564164194 | Compounding Force / catalog:weapon-frame-exotic | picked; gid 441434520, Arbalest /  / Compouding Force / Disruption Break / ↑Genesis, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:33:45.214Z |
| 3081173348 | The Fundamentals / catalog:weapon-frame-exotic | skipped | Once again, this is just the element swapping part. | 2026-11-01T09:32:53.351Z |
| 25023897 | Quicksilver Storm Catalyst / catalog:weapon-catalyst-exotic | accepted; gid 441434520, Quicksilver Storm /  / Missile Tracers / Grenade Chaser / ↑Nano-entanglement, Kinetic Slot Weapons; cells []; parts [] |  | 2026-11-01T09:33:57.892Z |
| 136852797 | Sleeper Simulant Catalyst / catalog:weapon-catalyst-exotic | accepted; gid 441434520, Sleeper Simulant /  / Dornröschen / Moving Target / ↑Accelerated Coils / ↑Deeper Pockets, Power Weapons; cells []; parts [] |  | 2026-11-01T09:37:01.447Z |
| 282266464 | Temporal Alignment Refit / catalog:weapon-catalyst-exotic | picked; gid 441434520, Graviton Spike /  / Temporal Manipulation I–IV / Temporal Anomaly / ↑Craftable Traits, Energy Slot Weapons; cells []; parts [] |  | 2026-11-01T09:35:19.908Z |
| 282266465 | Transcendent Zen Refit / catalog:weapon-catalyst-exotic | accepted; gid 1662574278, Transcendent Moment, Weapon Traits; cells [{"dRow":0,"dCol":2}]; parts [] |  | 2026-11-01T09:37:39.778Z |
| 1497627200 | Ergo Sum Catalyst / catalog:weapon-catalyst-exotic | note-only | The manual candidate is right despite me being unable to click accept. | 2026-11-01T09:36:52.773Z |
| 52638289 | CQC Optics: High / catalog:weapon-mod | accepted; gid 1662574278, CQC Optics: High, Enhanced Weapon Mods are equippable only on Tier 4 and Tier 5 Weapons.; cells []; parts [] |  | 2026-11-01T09:38:23.624Z |
| 231101171 | Random Masterwork / catalog:weapon-mod | no-equivalent | Does not need a tooltip. | 2026-11-01T09:38:53.723Z |
| 299264772 | Adept Range / catalog:weapon-mod | no-equivalent | not necessary  | 2026-11-01T09:41:32.024Z |
| 1197814525 | Abundant Ammo / catalog:weapon-mod | accepted; gid 1662574278, Abundant Ammo, Enhanced Weapon Mods are equippable only on Tier 4 and Tier 5 Weapons.; cells []; parts [] |  | 2026-11-01T09:38:57.326Z |
| 1285109625 | Jumpshot / catalog:weapon-mod | no-equivalent | this mod has already been retired and simply just hasn't been removed from the manifest | 2026-11-01T09:43:06.949Z |
| 74393640 | Facet of Defiance / catalog:subclass-fragment | accepted; gid 1918152785, Defiance, Fragments; cells []; parts [] |  | 2026-11-01T09:43:51.511Z |
| 537774542 | Whisper of Fractures / catalog:subclass-fragment | accepted; gid 1088259962, Fractures, Fragments; cells []; parts [] |  | 2026-11-01T09:43:56.392Z |
| 1051276348 | Ember of Eruption / catalog:subclass-fragment | accepted; gid 1186062409, Eruption, Fragments; cells []; parts [] |  | 2026-11-01T09:43:59.086Z |
| 1727069367 | Spark of Beacons / catalog:subclass-fragment | accepted; gid 618967225, Beacons, Fragments; cells []; parts [] |  | 2026-11-01T09:44:02.200Z |
| 2272984656 | Echo of Dilation / catalog:subclass-fragment | accepted; gid 1907852650, Dilation, Fragments; cells []; parts [] |  | 2026-11-01T09:44:04.685Z |
| 83039192 | Hellion / catalog:subclass-aspect | accepted; gid 1186062409, Hellion, Aspects; cells []; parts [] |  | 2026-11-01T09:44:10.624Z |
| 83039193 | Touch of Flame / catalog:subclass-aspect | accepted; gid 1186062409, Touch of Flame, Fragments; cells []; parts ["Scans up to ↑5 enemies in Line of Sight within ↑12 metres upon impact.","Explodes again after 0.5 seconds, dealing up to 851 [50] damage in a 8 metre radius.\nDeals up to 1,589 [180] damage and inflicts x40+20 Scorch with both explosions.","Applies Cure ↑x2 to user and allies. Restoration Orb applies ↑x2 Restoration for 4+2 seconds.","Solar Grenade lasts for ↑6 seconds.\nSolar Flare releases Magma Orbs around it every ? seconds, each dealing 125 [50] damage without falloff.","Aspects"] |  | 2026-11-01T09:45:01.003Z |
| 187655372 | Trapper's Ambush / catalog:subclass-aspect | accepted; gid 1907852650, Trapper's Ambush, Aspects; cells []; parts [] |  | 2026-11-01T09:45:17.458Z |
| 262821312 | Weavewalk / catalog:subclass-aspect | accepted; gid 1870531554, Weavewalk, Aspect; cells []; parts [] |  | 2026-11-01T09:45:39.791Z |
| 262821318 | Mindspun Invocation / catalog:subclass-aspect | accepted; gid 1870531554, Mindspun Invocation, Fragments; cells []; parts ["Grapple Melee creates 3 Threadlings on hit.","Grants Weaver's Trance for 25 seconds.\nKills while Weaver's Trance is active cause the enemy to trigger a Suspending explosion on death.\nSuspending Explosion deals 108 [?] Strand Grenade Ability Damage to enemies within 6 meters.","The fourth explosion will release 4 submunition in a X formation, each dealing up to 64 [?] damage and spawning a Tangle.\nIgnores Tangle Creation Cooldown.","Hold [Grenade] to prepare a Nest Grenade.\nNest Grenade creates a Teeming Nest on impact.\n\nTeeming Nest: 300 Construct HP. Lasts for 17.5 seconds, constantly draining 6.7% (-20) HP per second 1.5 seconds after reaching Full Health.\nGives birth to 3 Threadlings on deployment, followed by a Threadling every 5 seconds.","Aspect"] |  | 2026-11-01T09:45:50.178Z |
| 119041298 | Thundercrash / catalog:subclass-super | accepted; gid 618967225, Thundercrash, Aspect; cells []; parts [] |  | 2026-11-01T09:45:55.907Z |
| 375052468 | Golden Gun: Marksman / catalog:subclass-super | accepted; gid 1186062409, Golden Gun: /  Marksman, Fragments; cells []; parts [] |  | 2026-11-01T09:45:58.872Z |
| 1656118680 | Nova Warp / catalog:subclass-super | accepted; gid 1907852650, Nova Warp, Aspects; cells []; parts [] |  | 2026-11-01T09:46:08.575Z |
| 1885339915 | Needlestorm / catalog:subclass-super | accepted; gid 1870531554, Needlestorm, Aspect; cells []; parts [] |  | 2026-11-01T09:46:11.603Z |
| 2274196887 | Well of Radiance / catalog:subclass-super | accepted; gid 1186062409, Well of Radiance, Aspects; cells []; parts [] |  | 2026-11-01T09:46:04.156Z |
| 1399216 | Duskfield Grenade / catalog:subclass-grenade | accepted; gid 1088259962, Duskfield Grenade, Fragments; cells []; parts [] |  | 2026-11-01T09:46:16.627Z |
| 1399218 | Shatter Grenade / catalog:subclass-grenade | accepted; gid 1088259962, Shatter Grenade, Fragments; cells []; parts [] |  | 2026-11-01T09:46:31.214Z |
| 146194908 | Skip Grenade / catalog:subclass-grenade | accepted; gid 618967225, Skip Grenade, Fragments; cells []; parts [] |  | 2026-11-01T09:46:21.755Z |
| 886607940 | Magnetic Grenade / catalog:subclass-grenade | accepted; gid 1907852650, Magnetic Grenade, Fragments; cells []; parts [] |  | 2026-11-01T09:46:38.355Z |
| 1225978592 | Grapple / catalog:subclass-grenade | accepted; gid 1870531554, Grapple, Fragments; cells []; parts [] |  | 2026-11-01T09:46:26.772Z |
| 852252788 | Hammer Strike / catalog:subclass-melee | accepted; gid 1186062409, Hammer Strike, Aspects; cells []; parts [] |  | 2026-11-01T09:46:58.039Z |
| 1139822080 | Phantom Surge / catalog:subclass-melee | accepted; gid 1907852650, Phantom Surge, Fragments; cells []; parts [] |  | 2026-11-01T09:47:16.571Z |
| 1680616210 | Threaded Spike / catalog:subclass-melee | accepted; gid 1870531554, Threaded Spike, Fragments; cells []; parts [] |  | 2026-11-01T09:47:03.502Z |
| 1980796560 | Shield Throw / catalog:subclass-melee | accepted; gid 1907852650, Shield Throw, Aspects; cells []; parts [] |  | 2026-11-01T09:47:06.996Z |
| 2657901004 | Knife Trick / catalog:subclass-melee | accepted; gid 1186062409, Knife Trick, Fragments; cells []; parts [] |  | 2026-11-01T09:47:09.422Z |
| 25156514 | Empowering Rift / catalog:subclass-class | accepted; gid 527596209, Empowering Rift, Warlocks intrinsically possess the following traits over Titans and Hunters: /  / 1.1x Grenade Regeneration Speed. / 5% [2.5%] Increased Grenade Ability Damage.; cells []; parts [] | that compendium data path looks like a mess, could use some refinement | 2026-11-01T09:48:38.382Z |
| 25156515 | Healing Rift / catalog:subclass-class | accepted; gid 527596209, Healing Rift, Warlocks intrinsically possess the following traits over Titans and Hunters: /  / 1.1x Grenade Regeneration Speed. / 5% [2.5%] Increased Grenade Ability Damage.; cells []; parts [] | that compendium data path looks like a mess, could use some refinement | 2026-11-01T09:49:34.398Z |
| 426473316 | Marksman's Dodge / catalog:subclass-class | accepted; gid 527596209, Marksman's Dodge, Hunters intrinsically possess the following traits over Titans and Warlocks: /  / Base Sprint Speed is 8.5 meters per second, compared to their baseline of 8m/s. / Baseline 100 [70] Mobility and 0.9x [0.95x] Ready/Stow Animation Duration. / Sprint Speed Increase is equivalent to that of an Exotic Armor-based Sprint Boost, only being able to stack with a Lightweight Weapon.; cells []; parts [] | that compendium data path looks like a mess, could use some refinement | 2026-11-01T09:48:24.374Z |
| 426473317 | Gambler's Dodge / catalog:subclass-class | accepted; gid 527596209, Gambler's Dodge, Hunters intrinsically possess the following traits over Titans and Warlocks: /  / Base Sprint Speed is 8.5 meters per second, compared to their baseline of 8m/s. / Baseline 100 [70] Mobility and 0.9x [0.95x] Ready/Stow Animation Duration. / Sprint Speed Increase is equivalent to that of an Exotic Armor-based Sprint Boost, only being able to stack with a Lightweight Weapon.; cells []; parts [] | that compendium data path looks like a mess, could use some refinement | 2026-11-01T09:49:19.438Z |
| 489583096 | Towering Barricade / catalog:subclass-class | accepted; gid 527596209, Towering Barricade, Titans intrinsically possess the following traits over Hunters and Warlocks: /  /  20% [5%] Increased Basic Melee Damage. / Increased damage is multiplicative.; cells []; parts [] | that compendium data path looks like a mess, could use some refinement | 2026-11-01T09:48:55.465Z |
| 5333292 | Strafe Glide / catalog:subclass-movement | no-equivalent |  | 2026-11-01T09:49:45.726Z |
| 5333293 | Burst Glide / catalog:subclass-movement | no-equivalent |  | 2026-11-01T09:49:53.116Z |
| 5333294 | Balanced Glide / catalog:subclass-movement | no-equivalent |  | 2026-11-01T09:49:54.552Z |
| 5333295 | Blink / catalog:subclass-movement | no-equivalent |  | 2026-11-01T09:51:58.768Z |
| 20616656 | Triple Jump / catalog:subclass-movement | no-equivalent |  | 2026-11-01T09:52:02.576Z |
| 37177486 | Firesprite / catalog:verbs | accepted; gid 1186062409, Firesprite, Glossary; cells []; parts [] |  | 2026-11-01T09:52:15.224Z |
| 37938188 | Shatter / catalog:verbs | accepted; gid 1088259962, Shatter, Glossary; cells []; parts [] |  | 2026-11-01T09:52:46.566Z |
| 106947924 | Frost Armor / catalog:verbs | accepted; gid 1088259962, Frost Armor, Glossary; cells []; parts [] |  | 2026-11-01T09:52:50.416Z |
| 345967499 | Transcendence / catalog:verbs | accepted; gid 1918152785, Transcendence, Glossary; cells []; parts [] |  | 2026-11-01T09:52:58.165Z |
| 1514833946 | Darkness Debuffs / catalog:verbs | no-equivalent |  | 2026-11-01T09:52:35.579Z |
| 23016037 | Colossus Armorer / catalog:ghost-mod | no-equivalent |  | 2026-11-01T09:54:01.164Z |
| 275904576 | Ultimate Glimmer Booster / catalog:ghost-mod | no-equivalent |  | 2026-11-01T09:54:03.842Z |
| 275904577 | Supercharged Glimmer Booster / catalog:ghost-mod | no-equivalent |  | 2026-11-01T09:54:05.774Z |
| 275904580 | Standard Glimmer Booster / catalog:ghost-mod | no-equivalent |  | 2026-11-01T09:53:58.811Z |
| 275904581 | Meager Glimmer Booster / catalog:ghost-mod | no-equivalent |  | 2026-11-01T09:53:57.123Z |

### Inherited narrow source-name conventions (generated from code)

Every mapping below is an existing candidate-name convention, not a new semantic approval. Category/source confirmation and parent identity gates still apply. Regression coverage lives in core link/resolve/config suites and frozen catalyst/refit examples; wrong categories, shared generic perks and unsupported parents remain counterexamples.

| Item/group | Candidate source name | Runtime rule family | Date/source |
|---|---|---|---|
| Spinning Up | SUROS Regime | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Dual Speed Receiver | SUROS Regime | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Time-Slip | No Time to Explain | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Restorative Turret | Healing Turret | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| The Scientific Method | Scientific Method | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Tri-Planar Mass Driver | Tri-Planar Mass | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Resurgence Directive II | Resurgence Directive | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Resurgence Directive III | Resurgence Directive | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Resurgence Directive IV | Resurgence Directive | exoticSourceNames; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Jade Rabbit Catalyst | The Jade Rabbit | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Prometheus Catalyst | Prometheus Lens | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Wardcliff Coil Catalyst | The Wardcliff Coil | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Worldline Catalyst | Worldline Zero | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Whisper Catalyst | Whisper of the Worm | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Khvostov Catalyst | Khvostov 7G-0X | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Acrius Catalyst | Legend of Acrius | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Skyburner Catalyst | Skyburner's Oath | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Colony Catalyst | The Colony | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |
| Prospector Catalyst | The Prospector | catalystWeapons; exotic-catalog-parent / exotic-name-line-or-catalyst | 2026-10-31, inherited config.ts convention (742b320); candidate hint, not owner approval |

### Inherited stat-description exceptions (generated from code)

manifest-weapon-stat uses the following exact descriptive lead-in group, plus stat-only bullets and manifest/socket evidence. A matching lead-in alone never excludes an effect. Source: 2026-11-01, manifestRule.ts (7908a26), earlier owner-guided stat-scope implementation. Independent conditional/effect-bearing attachment counterexamples are listed in the main rule table; unknown lead-ins reject.

- High stiffness for quick handling.
- Sturdy iron sights.
- Agile, snappy scope. Short zoom.
- Powerful scope. Long zoom.
- This weapon can fire longer distances.
- Durable yet light bowstring.
- Reduces weight for faster reloads.
- Light sniper scope. Short zoom.
- Long-distance Häkke scope. Long zoom.
- Combat sniper scope. Short zoom.
- Heavy, high capacity drum.
- Balanced shotgun barrel.
- Omolon post sight. Short zoom.
- Light and stable shaft material.
- Snapshot sight. Short zoom.
- Lightweight sniper sight. Medium zoom.
- Stable Sidearm sight.
- Sharp Hand Cannon sight.
- Vicious scope. Long zoom.
- Light flexible sight. Medium zoom.
- Far scope. Long zoom.
- Lightweight sight. Short zoom.
- Strong battery life.
- Pinpoint Sidearm sight.
- Agile Hand Cannon sight.
- Ultra-light barrel.
- Focused scope. Long zoom.
- Barrel optimized for distance.
- Agile post sights. Short zoom.
- Agile iron sights. Short zoom.
- Durable ranged barrel.
- Accurate Hand Cannon sight.
- Agile sight. Short zoom.
- Large heavy battery.
- Rugged and simple iron sights. Short zoom.
- Circular iron sights. Short zoom.
- Omolon Post sights. Short zoom.
- Superior scope. Short zoom.
- Assault scope. Long zoom.
- Häkke marksman scope. Long zoom.
- Lightweight, agile battery.
- Balanced scope. Medium zoom.
- Strong optics. Long zoom.
- Ocular sights. Long zoom.
- Red-dot. Medium zoom.
- Improves stability.
- Barrel optimized for recoil reduction.
- Distance optimizations.
- Agile Sidearm sight.
- Precision scope. Long zoom.
- Accurized sight. Medium zoom.
- Ranged scope. Long zoom.
- Ranged shotgun barrel.
- Häkke holo sights. Medium zoom.
- Thin-lens scope. Short zoom.
- Balanced Sidearm sight.
- SUROS projection sight. Short zoom.
- Dual strength barrel.
- SUROS lightweight red-dot sight. Short zoom.
- SUROS holo sights. Medium zoom.
- SUROS ranged combat scope. Long zoom.
- Lightweight scope. Short zoom.
- Stable Hand Cannon sight.
- Optimized for extended range.
- Pinpoint Hand Cannon sight.
- Accurate Sidearm sight.
- This weapon has multiple small improvements.
- Sharp Sidearm sight.
- Omolon red-dot. Medium zoom.
- Balanced Hand Cannon sight.
- Light, flexible sight. Short zoom.
- Scrappy scope. Medium zoom.
- Balanced scope. Short zoom.
- Lightly vented barrel.
- This shotgun's magazine is optimized for quick combat.

### Core pass3 reviewed source registry

These are guarded template/import-closure rules, not generic parent-card approval. The registry hashes, rule values and dependency sets below are generated directly from the data consumed by core.

| Hash | Item/category | Source rule | Destination/dependencies | Date/source |
|---|---|---|---|---|
| 95528736 | Onslaught / weapon-trait | primary-name | gid 1662574278, Onslaught, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 95528736 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 110793779 | Void/Strand Dual Siphon / armor-mod-general | explicit-main-import | gid 1934379638, Siphon / [1–2–3 Energy], Helmet; cells [{"dRow":0,"dCol":2}]; closure 110793779, 2724068510 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 282266465 | Transcendent Zen Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Transcendent Moment, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 282266465, 3731491409 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 282266466 | Subsistence Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Subsistence, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 282266466, 1820235745 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 282266467 | Rapid Hit Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Rapid Hit, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 282266467, 247725512 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 372672210 | Vorpal Weapon Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Vorpal Weapon, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 372672210, 1546637391 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 372672211 | Hatchling Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Hatchling, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 372672211, 831391274 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 521530777 | Thermodynamic Siphon / armor-mod-general | explicit-main-import | gid 1934379638, Siphon / [1–2–3 Energy], Helmet; cells [{"dRow":0,"dCol":2}]; closure 521530777, 2724068510 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 657773637 | Sniper Damage Resistance / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 657773637, 707237917, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 707237917 | Sniper Damage Resistance / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 707237917, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 777589556 | No Distractions / weapon-trait-exotic | explicit-main-import | gid 1662574278, No Distractions, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 777589556, 2866798147 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 930759851 | Concussive Dampener / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 930759851, 3719981603, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 956288240 | Onslaught / weapon-trait-enhanced | explicit-main-import | gid 1662574278, Onslaught, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 956288240, 95528736 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1266037484 | Pressurized Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Under Pressure, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1266037484, 1645158859 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1266037485 | Frenzy Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Feeding Frenzy, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1266037485, 2779035018 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1266037486 | 4-Timer Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Fourth Time's The Charm, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1266037486, 1354429876 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1266037487 | Outlaw Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Outlaw, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1266037487, 1168162263 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1565861116 | Enhanced Nightmare Crusher / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Crusher / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 1565861116 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1763668984 | Melee Damage Resistance / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 1763668984, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1931951168 | Subsistence Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Subsistence, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1931951168, 1820235745 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1931951169 | Destabilizing Rounds Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Destabilizing Rounds, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1931951169, 2048641572 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1931951170 | Onslaught Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Onslaught, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 1931951170, 95528736 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 1996040463 | Enhanced Nightmare Banisher / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Banisher / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 1996040463 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2023980600 | Supreme Nightmare Breaker / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Breaker / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 2023980600 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2045123179 | Supreme Nightmare Crusher / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Crusher / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 2045123179 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2321824285 | Chaos Accelerant / subclass-aspect | aspect-role | gid 1907852650, Chaos Accelerant, Aspects; cells [{"dRow":0,"dCol":2}]; closure 2321824285 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2562645296 | Melee Damage Resistance / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 2562645296, 1763668984, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2812559045 | Arc/Strand Siphon Combo / armor-mod-general | explicit-main-import | gid 1934379638, Siphon / [1–2–3 Energy], Helmet; cells [{"dRow":0,"dCol":2}]; closure 2812559045, 2724068510 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2831374162 | Solar/Strand Dual Siphon / armor-mod-general | explicit-main-import | gid 1934379638, Siphon / [1–2–3 Energy], Helmet; cells [{"dRow":0,"dCol":2}]; closure 2831374162, 2724068510 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2883096192 | Stats for All Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Stats for All, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 2883096192, 1583705720 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2883096193 | Cascade Point Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Cascade Point, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 2883096193, 3751912585 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2883096194 | Repulsor Brace Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Repulsor Brace, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 2883096194, 776531651 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2883096195 | Loose Change Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Loose Change, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 2883096195, 1119449540 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 2940035732 | Wrath of the Colossus / weapon-frame-exotic | explicit-spelling-alias | gid 441434520, Grand Overture /  / Wrath of the Colosssus / Omega Strike / ↑Grand Overture Catalyst, Power Weapons; cells [{"dRow":0,"dCol":3}]; closure 2940035732 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3146691100 | Robber Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Grave Robber, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3146691100, 1631667848 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3146691101 | Immovable Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Immovable Object, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3146691101, 3800201097 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3146691103 | Feedback Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Replenishing Aegis, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3146691103, 1966281507 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3189860891 | Turnabout / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Turnabout, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3189860891, 2209918983 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3719981603 | Concussive Dampener / armor-mod-general | explicit-main-import | gid 1934379638, Resistance / [1–3 Energy], Chest; cells [{"dRow":0,"dCol":2}]; closure 3719981603, 953234331 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3829100654 | Supreme Nightmare Banisher / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Banisher / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 3829100654 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3865920552 | Relentless Strikes Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Relentless Strikes, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3865920552, 1749209109 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3865920553 | Attrition Orbs Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Attrition Orbs, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3865920553, 243981275 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 3865920555 | Burning Ambition Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Burning Ambition, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 3865920555, 2890807135 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 4193902249 | Enhanced Nightmare Breaker / armor-mod-activity | nightmare-tier-family | gid 1934379638, Nightmare Breaker / [1 \| 2 \| 3 Energy], Activity or Destination Specific; cells [{"dRow":0,"dCol":2}]; closure 4193902249 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 4204405032 | Target Lock Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Target Lock, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 4204405032, 365154968 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 4204405033 | One for All Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, One For All, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 4204405033, 4049631843 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 4204405034 | Hatchling Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, Hatchling, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 4204405034, 831391274 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |
| 4204405035 | High-Impact Reserves Refit / weapon-catalyst-exotic | explicit-main-import | gid 1662574278, High-Impact Reserves, Weapon Traits; cells [{"dRow":0,"dCol":2}]; closure 4204405035, 2213355989 | 2026-10-31, pass3 commit 9dfe706, reviewed-rules.json |

## Withheld and unresolved investigations

- Seven attachment sources: 1279785143, 2777563320, 1716000303, 2406549743, 137682932, 409831596, 3999527219. First six need tooltips, Remote Detonation is tentative. Base/enhanced counterpart identities inherit only that same named attachment-family decision. No parent/interaction-only source substitution.
- Elemental Siphon 3619040076: Harsh Refraction and Counter Energy are distinct mechanics. Artifact/plug mapping remains unresolved; never combine solely by name.
- Movement: the 53 group 6–8 members above remain optional, retained and unresolved for history/source investigation. Six sampled revisions in compendium-movement-history.json, compendium-hunter-jump-history.json and compendium-blink-history.json recovered no text; this is not proof none existed.
- The Fundamentals 2620589274/3081173348, Ergo Sum Catalyst 1497627200 and general Caster Frame 183772609 retain their unresolved owner references; only frame-specific coverage can resolve sword frames.
- Source changes, unsupported names, conflicting category/identity evidence, missing manifest facts, partial dependencies and ambiguous candidates retain explicit owner-review reasons rather than guessed equivalence.
- Deferred to separate work: manifest-removal archive and lost-tooltip checker/recovery. Root verified 153/159 cleared texts were never human-edited manifest copies; Ricochet Rounds contained the real sharper-angle addition. Concussion, Proximity and Remote Detonation history was manifest paraphrase. No archival, resurrection or history rewriting is performed by this matcher.

<!-- END GENERATED OWNER DECISIONS -->
