# Web app

The v2 browser app uses React 18, strict TypeScript, Vite, HashRouter, Zustand, and SCSS modules.
It loads the generator's `v2/templates/v2` catalog and the authored
`Live-Clarity-Database/editor-data-bundle/bundle.json`, validating all responses.

From the repository root, run `npm ci`, then `npm run dev`.
Open http://localhost:5173/. Run `npm run build` for a production build.
The web output is `apps/web/dist`. Vite uses relative asset URLs (`base: './'`) so it can
be hosted below a GitHub Pages repository path.

- `src/App.tsx`: routes; use router links to preserve browser back/forward history.
- `src/features/`: one folder for each feature. Empty folders reserve later work.
- `src/features/navigation/`: one compact layout with category/tooltip dropdowns at the
  top of the sidebar, name/hash search, alias resolution, and history-aware navigation.
  Categories are grouped by their registry group and order. Workspace navigation
  is a secondary dropdown. Shift+Scroll steps anywhere in the app, including
  inside editors, matching the original site. Unmodified wheel/arrow stepping
  also works on the Tooltip dropdown; ordinary page/editor scrolling is untouched.
  Stepping stays inside the selected category and stops at either end (no wrap,
  no category crossing). If the current tooltip is not in the filtered category,
  choose a tooltip explicitly before stepping.
  Explicit selections push history;
  stepping replaces immediately and commits one entry after a second idle.
- `src/ui/`: shared components and base styles.
- `src/services/`: generator, authored bundle, worker API, and native IndexedDB access.
- `src/stores/`: loaded data and per-tooltip `{base,next}` drafts. Draft recovery
  completes before editing. Failed recovery blocks editing; failed writes keep
  edits in memory and show a persistent retry warning. Wait for "Saving local
  drafts" to disappear before closing. Discard removes only the chosen tooltip's draft.
  Atomic compare-before-write prevents a second tab from silently overwriting
  drafts changed elsewhere; retain both tabs if that warning appears.
- `src/features/tooltip/`: selected language, base and all enhanced variants,
  editor/preview composition. Enhanced and sandbox URLs replace to the base route.
  Generic `aliases.json` also redirects same-name weapon frames to their canonical
  tooltip. Frame groups have one editor (no separate enhanced text), one navigation
  entry in the canonical member's category and a small `×N` member count.
  Imports by any alias hash use canonical text, including current drafts. Recovered
  drafts for former member hashes appear as explicit conflicts in navigation:
  open the shared tooltip, copy the text to keep, then discard the old draft.
  They are never applied automatically or silently dropped.
- `src/data/`: original SCSS theme variables and mixins, copied from legacy.
- `src/assets/`: the original DestinySymbols font.

## Editor and preview

`#/globals` lists variable/title definitions and distinct-tooltip usage counts, including
references in reusable exports and local titles. Detail links carry the language, variant,
and original line number; the editor selects and scrolls to that source line. Counts update
with local drafts. Reserved tooltips 2 and 3 also show their total usage count.

Each tooltip variant has an ordered associated-tooltip picker (name/hash search, including
verbs and alias hashes). Editors, trial editors and maintainers may add/remove/reorder
entries; these edits use the same persistent draft and save flow as text. Aliases resolve
to canonical hashes, self/duplicate additions are excluded. Previews show compact
expandable associated entries with navigation links; nested associations are not expanded
recursively.

`features/editor` exports `<ClarityEditor value lang onChange globals readOnly? />`.
`features/preview` exports `<TooltipPreview text lang name icon? categoryLabel? globals />`.
Both accept raw `text[lang].text` and the core `MarkupGlobals` shape:
`{ variables, titles, imports?, type? }`. Provide selected-language raw text for
all tooltips in `imports` (keyed by hash; hash 1 contains global exports) and
the category's `legacyType` as `type`. No component fetches data.
The core parser drives validation and rendering; title popovers work by hover
and keyboard focus, and weapon-specific sections have a preview selector.

CodeMirror has native `spellcheck="true"` and a BCP-47 `lang` on its editable
content (Chinese `zh-chs`/`zh-cht` map to `zh-Hans`/`zh-Hant`). Native underlines
require spelling enabled and the corresponding browser dictionary installed;
the application cannot install or force a dictionary. Right-click a misspelling
for native suggestions. Ctrl/Cmd+Space completes variables, title references,
import names/targets and formatting; Ctrl/Cmd+Z undoes; Ctrl/Cmd+/ toggles comments.
Scroll Lock and Ctrl/Cmd+Shift+F align table columns in one undoable transaction.
Changing to an externally supplied document clears undo history, preventing
undo from restoring a different tooltip or language.

## Compendium tracking

`#/compendium` lists linked tooltips whose source text or styling changed, newest
first, with a navigation count badge. The Unlinked list supports incremental linking.
The tooltip's Compendium panel suggests exact name matches, lets editors choose a
tab and row, and remembers the tab per category. Linking/unlinking is a local draft.
Literal uppercase `OLD` tab names are excluded; lowercase and mixed-case names remain.

The panel preserves source run colors, font sizes, emphasis and safe links. Inline
word changes and style-only changes are distinct; hover, focus or tap a dotted style
change to inspect both styles. A toggle shows snapshot/current cells side-by-side.
Editor+ **Mark as reviewed** saves only the current snapshot through the normal
review flow; save or discard an existing draft first. English saves refresh linked
snapshots; translation-only saves do not.

Source age and manual refresh progress are shown on the Compendium page. The save
summary offers refresh when linked data is over one hour old. Refreshes are authorized
by the Worker and run in the separate public Compendium-data repository; failed runs
are explicit and unchanged successful runs finish without requiring a data commit.

## Worker connection

Set `VITE_API_URL` in `apps/web/.env.local` to the worker origin before starting Vite.
Without it, the app is explicitly read-only (existing drafts remain recoverable).
The worker client redirects login to `/auth/login`; the worker returns to
`#/auth/callback?session=…`. The callback immediately removes the token from the URL,
keeps it in tab-scoped sessionStorage (survives reload, not tab closure), and sends
it as `Authorization: Bearer …` on `/me` and `/save`. Sign out clears that session.
A signed-out user or an account without a role is read-only. Translators can edit only
their assigned languages; other languages remain visible but read-only. Trial users
may edit but cannot push live. Shared role helpers live in `features/auth/permissions.ts`;
server authorization remains authoritative.

## Saving and conflicts

The sidebar's **Review and save drafts** opens a modal before any `/save` request.
It lists every changed tooltip with per-language word diffs and an optional commit
message. Core validation runs against the prospective save (including simultaneous
global changes and canonicalized alias imports), not unrelated unsaved drafts.
Empty English descriptions and parser/import errors block saving; unknown
variables/titles are warnings. Declaration-only global tooltips (reserved hashes 0-3)
do not require an English description. The editor underlines issues and lists them
under Markup help; the save summary lists issues from every stored language.

Enrichers in `services/save/enrichers/` run sequentially just before the request.
Changed languages receive the signed-in login and save timestamp; changed translations
record the current English revision. English changes leave translations untouched.
Bungie/Compendium snapshots refresh only on English edits or an explicit editor+
Mark reviewed action; translation-only saves do not refresh either snapshot.
An enrichment failure stops the request and leaves all local drafts intact.

A 409 opens a field-by-field base/theirs/mine dialog. Choose either version or edit
merged text (other fields use validated JSON), then review again. Automatic merges
of other languages and association sets survive resolution. Resubmission uses the
returned head as base. Retryable branch races and API failures are explicit; drafts
are removed only after a validated successful response, never on a conflict.

Feature actions that save one tooltip without unrelated drafts call
`reviewSaveChanges([{hash, base, next}])` from `services/save/state.ts`.
The shared UI performs validation, enrichment, review, and conflict resolution and
updates the in-memory bundle on success. Existing unrelated drafts stay intact.
`replaceDraft(base, next)` in `services/save/drafts.ts` loads a full-tooltip restore
as a persisted draft while preserving its original dirty base.
`ui/diff` exports `WordDiff({before,after})` and `diffWords(before,after)` for other
feature views. `apiRequest(path, init?)` provides an authenticated raw response;
feature services must validate its body and handle non-success statuses.

Run root `npm test` for catalog/history/draft/API tests, including actual IndexedDB
transactions via fake-indexeddb. Put component styles in `*.module.scss` and shared
domain logic in `packages/core`.
