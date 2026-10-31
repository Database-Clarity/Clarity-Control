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

The review route shows one entry beside its proposed source and nearby styled sheet cells.
A/P/N/S/U accept, open the picker, mark no equivalent, skip, and undo. Shortcuts ignore
text fields, modifiers, repeat events, and open overlays. Escape closes either overlay.
Actions remain in the fixed bottom bar. On phones the panels stack and decisions bring
the next entry into view. Unusually long descriptions scroll inside desktop panels.

Proposal matching uses the existing core auto-link resolver in a dedicated Web Worker,
once per editor/source revision. Only round-trippable whole-description proposals enter
bulk preview; fuzzy candidates and research hints require manual selection. Bulk preview
respects category, search, status and proposal filters and creates normal local drafts.
Undo is one in-memory transaction (including a bulk transaction), restores only link
metadata and local progress, and refuses changed links or a changed saved data revision.
It never rolls back text/association edits or a remote save. Reopen remains available for
local skip/no-equivalent decisions. Normal draft storage, roles and Worker save are unchanged.
