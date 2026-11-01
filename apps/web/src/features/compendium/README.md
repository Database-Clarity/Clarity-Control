# Compendium review

`#/compendium` retains Needs attention and Unlinked. **Review matches** opens
`#/compendium/review`: unlinked canonical tooltips and links resolving to missing
or candidates. Sandbox/frame aliases are excluded; enhanced tooltips that own
distinct text remain separate. Saved healthy links enter this queue only when
there is local review history. Counts describe this queue, not total coverage.

Select a tooltip, inspect its English text, then use the shared LinkPicker and
CellPicker. Tab suggestions come from core category configuration; section
suggestions use actual parsed labels matching configured section categories.
These are navigation hints, never automatic matches. Unknown sections remain
unknown. Every tab and parsed section is available, and full-grid text search can
locate arbitrary anchors. Buttons and native selects support keyboard use; wide
sheet content scrolls inside a focusable region on narrow screens.

`confirmCompendiumSelection` validates both ordinary rows and ordered relative
cell offsets. A confirmed link updates only `compendium` on the existing normal
draft, preserving text, associations, and its original base. The normal save
summary, validation, conflicts and server permissions remain authoritative.
Drafted means **not saved**; discarding/reloading without a draft cannot count as
completion. Linking requires API configuration, recovered drafts, no save lock,
and an editor/trial/maintainer role. Other visitors may browse the same picker.

## Local progress

`reviewProgress.ts` defines a small version-1 localStorage record: selected hash,
query, category, status filter, and hash-keyed `open`, `skipped`, or
`no-equivalent` decisions with evidence fingerprints. The key scopes progress by
bundle URL, Compendium URL, API URL, and authenticated user ID; anonymous progress
has a separate explicit scope and is never adopted into a user's progress.
Identity changes remount the queue. Corrupt/unsupported records and unavailable
storage surface alerts; failed writes retain usable in-memory progress.

Skip, No equivalent found, and Reopen modify only this local record. They do not
write Tooltip metadata, share across devices, or train a model. The fingerprints
cover source tabs/grid content (not fetch timestamps) and the entry's name,
category, saved English text and saved link. Any changed sheet content
conservatively reopens tentative negative decisions, even if unrelated to the
entry; filters chosen by the user remain in effect. This may require repeated
review but prevents silently suppressing new evidence. Saved valid links always
win over local negative decisions. Local decisions can be revisited via All queue
entries or their status filter. Browser storage clearing removes local progress;
the separately stored normal drafts and authoritative saved links keep their
existing lifecycle. Cross-tab synchronization is not implemented.

## Research integration

`suggestions.ts` exports optional `CompendiumSuggestion` (`gid`, optional actual
section or transient grid anchor, and plain-language rationale). LinkPicker's
optional `suggestions` prop can receive reviewed per-entry evidence later.
`suggestionAnchor` resolves navigation into the current dataset, including
arbitrary grid anchors. Suggestions never bypass confirmation or become link
identity; stale/unavailable anchors cannot create drafts by themselves. This
increment adds no bulk matching rules or static per-tooltip guess list.

Run root `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
Run `npm run test:picker-browser` with an installed Chromium browser (or set
`PICKER_BROWSER` to its executable) for the offline synthetic picker pointer regression.
It uses an in-memory guidance document and starts no server.
Queue regressions live in `reviewQueue.test.ts`; relative-cell confirmation and
English/translation save invariants remain in selection/enricher/core tests.
Changed UI still requires independent wide/narrow rendered verification.

Reviewed research hints (October 31, 2026) now feed the existing typed suggestions
API on `#/compendium/review`. `research-hints.json` shares navigation places across
523 unresolved/excluded records, including all 41 human candidates. It contains
no authoritative links or absolute coordinate identity. The generator and dated
provenance are documented in `scripts/compendium-link/README.md`.

`researchSuggestions.ts` re-finds unique full anchor text on the current grid,
rebuilds the nearby window, compares a content fingerprint and reads the actual
parsed section. Missing/duplicate anchors or changed windows show warnings; unsupported
sections stay unknown and all-tab search remains available. Whole-source proposals,
partial mechanics and related navigation are distinguished, never silently accepted.
Fingerprinting is change detection, not a security assertion. `importContext.ts`
provides bounded authored dependency inspection (with missing/cycle notices), beside
current in-game descriptions. Draft/save authorization and local provisional negative
decisions retain their existing behavior. Progress changes do not recompute source
evidence or the selected item's navigation hints. Source/browser independent review
must cover this new candidate and the preceding responsiveness fix.

## Rapid review workspace

The review route lands on **Resolve a few examples**. Canonical queue entries are
partitioned by the generator's exact `categoryId` (stable `catalog:<encoded id>`
identities), including enhanced entries that own distinct text, custom entries
and explicit unknown-category fallbacks. The catalog supplies labels, ordering
and meaningful armor/weapon/subclass/ghost groupings. Each entry belongs to exactly
one category and one matching-reason subgroup. Missing manifest descriptions
(including all alias members), validated proposals, fuzzy-only candidates and no
resolver candidate are distinct; pending/failed matching is never reported as
no candidate. Research navigation hints are not resolver proposals.

A category list shows sample progress and entry counts. Each category has up to five
deterministic representative samples covering resolver states, available catalog structure
(shared owners, enhanced, aliased, custom or single items), description patterns and source
sections. There is no separate item-subtype field in this catalog; none is fabricated.
Select a sample to compare full manifest/authored and styled source descriptions inline.
Accept proposed link, Pick other, No equivalent and Skip record local references, not tooltip
drafts. The existing full row/cell picker validates manual choices without requiring sign-in
in this reference-only mode; ordinary linking keeps its role/API/storage/save-lock gates.
Notes per sample and the category comment are optional. Skip and note-only examples do
not count as resolved. Previously annotated examples remain reachable if matching changes
the suggested sample selection. Evidence changes flag old decisions and exclude them from
progress. Clear decision removes a resolution while preserving its note. Category browse
remains incremental (20 entries at a time); desktop panels scroll internally, phone panels stack.
**Review these one by one** scopes the existing rapid review to the category;
**Review all one by one** retains the full queue. URL query parameters preserve
back/forward navigation. Category mode does not handle rapid-review shortcuts.

### Owner guidance and later steps

In Vite development only, `GET/POST /__review-guidance` reads/writes
`apps/web/review-guidance.json` (ignored, beside this worktree's web package).
Comments, notes and reference decisions autosave after 400 ms idle and on blur; the browser backup updates on
each keystroke. The UI explicitly distinguishes disk success, pending,
local-only failure, browser backup failure and conflicts. Agents read this file
directly; no owner export is needed. Phones using this same dev server read the
same file. A different origin/server has a separate browser backup but shares
the disk file when it uses this worktree.

The version-1 document records dataset URLs, source revision/content fingerprint,
category rule/name/count/ordered hashes, active state and comment. Optional category
`references`, keyed by entry hash, extend existing version-1 files without dropping comments.
References record hash/name/categoryId, decision, note, timestamp, baseline and entry evidence;
accepted/picked sources additionally record a validated link with styled snapshot and
sourceHash/name/tab/row. Source hashes fingerprint the selected location and styled content,
not a fabricated numeric item hash. Sample evidence also covers the displayed manifest
descriptions and alias membership/catalog structure, which can change independently of the
authored bundle revision. Updated
membership preserves comments and reference records by stable id; removed categories remain inactive
with their last membership for audit. Disk writes require same-origin JSON,
schema validation and an exact file revision. A file lock serializes separate
Vite processes; temp-file fsync/rename replaces the file atomically. Conflicts
never overwrite disk or silently merge owner text. A stale browser backup or HTTP 409
pauses disk autosave but no longer disables local typing or sample resolution. Export the unsaved backup,
then explicitly reload disk guidance to reconcile. Reload pauses comment
editing and save retries until its disk read completes.
If guidance changes during that read, the new text and pending browser backup
are retained instead of acknowledging the older disk document. Reload cannot
overlap a save or another reload. A leftover `.lock` after a
crash produces a visible error; remove only that specific lock after verifying
no guidance writer owns it. Production builds and `vite preview` have no write
endpoint: comments there are explicitly browser-only until exported/retried on
the dev server. Guidance is local owner planning, not authentication, a review
blanket category approval, a normal draft, or permission to save/publish.

Step 2 (separate agent task) reads resolved sample references, notes, active comments and
recorded membership, checks the baseline and individual source evidence, then explains the
mapping pattern per category and proposes decisions supported by those references.
Report confidence, supporting reference identities and uncertain/uncovered items with
per-entry reasons through normal drafts or a separate versioned decisions file.
Skipped, note-only and stale samples are not resolved references.
It must not silently accept fuzzy matches or infer approval from guidance.
Uncovered/ambiguous cases become one follow-up question per category; changed
baselines require renewed evidence, not stale category-wide application.
Step 3 (later UI) presents a small sample stratified by proposal type plus all
flagged exceptions. Owner approval/rejection covers the exact category decision
set and evidence revision, not arbitrary future membership. Rejections with new
comments loop back to step 2. Accepted link changes still use normal draft/save,
roles and Worker gates; no data publication is part of these steps.

### Guided proposal preview

The category view now has a non-mutating guided preview. It uses the guidance
captured at the last disk/browser load, before automatic membership synchronization;
reload disk guidance after saving new references or notes to refresh that input.
It shows the full recorded scope, stratified explicit/inferred/exception samples,
source snapshots, supporting reference hashes, reasons and high/unresolved counts.
Existing links and local human decisions are preserved. New category members are
excluded. Scope/baseline mismatches, missing or changed entry/source evidence,
skips and note-only records never become mapping examples.

The bounded rule is exact normalized-name, validated whole-description resolver
links, supported by at least two current same-category references in the same
source tab and section. Notes and comments require human interpretation and do
not authorize inferred mappings. Picked renames and no-equivalent examples apply
only to the explicitly resolved entry. Confidence means evidence-backed proposal,
not owner approval, a probability or model training.

Generate an inspectable decisions file without opening the UI or exporting again:
`node scripts/compendium-guidance/report.mjs <guidance.json> <new-output-directory>`.
This reads the existing local guidance plus current public generator, bundle and
Compendium inputs; it writes only a new report directory, never the guidance or
remote data. The JSON records input digest/baselines, revision, complete per-entry
evidence, preserved reference snapshots/notes, category patterns and stale issues.

Category accept/reject semantics remain a product decision. This increment offers
preview only, with no draft/progress/category-decision mutation and no save action.
Normal individual draft/save roles, conflicts and undo remain the existing path.
Synthetic browser fixture: `/test/guided-preview.html` (network disabled).

### Individual review

Individual review shows one entry beside its proposed source and nearby styled sheet cells.
A/P/N/S/U accept, open the picker, mark no equivalent, skip, and undo. Shortcuts ignore
text fields, modifiers, repeat events, and open overlays. Escape closes either overlay.
Actions remain in the fixed bottom bar. On phones the panels stack and decisions bring
the next entry into view. Unusually long descriptions scroll inside desktop panels.

Proposal matching uses the existing core auto-link resolver in a dedicated Web Worker,
once per editor/source revision. Only round-trippable whole-description proposals enter
bulk preview; fuzzy candidates and research hints require manual selection. Bulk preview
freezes the category/search/status/proposal-filter membership at opening.
Acceptance creates drafts only for the currently displayed page (up to ten),
then closes the preview; undisplayed pages are never accepted. Changed source,
catalog, entry evidence, proposals, local decisions or drafts invalidate the
preview and require reopening it. Bulk accept and undo use atomic normal draft updates.
Undo is one in-memory transaction (including a bulk transaction), restores only link
metadata and local progress, and refuses changed links or a changed saved data revision.
It never rolls back text/association edits or a remote save. Reopen remains available for
local skip/no-equivalent decisions. Normal draft storage, roles and Worker save are unchanged.
