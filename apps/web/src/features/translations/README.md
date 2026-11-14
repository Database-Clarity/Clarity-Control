# Translator queue

The Translations tab lists, for one language, every tooltip that still needs work: one dense row per
tooltip (name, category, state), opening the editor in translate mode (`/t/<hash>?lang=<language>`).
Core's `translationStateOf` classifies each translatable tooltip as `missing` (English exists, no saved
translation), `outdated` (known source revision older than the current English) or current;
`translationQueue` is the same rule over a list. Translations without a known `sourceUpdatedAt` count as
current: missing source metadata is deliberately not guessed.

`queue.ts` builds a per-data index once. Never listed: aliases, archived tooltips, tooltips without English
text, set-selector items, and items classified Inactive & Placeholder. Rows are outdated first (largest
English gap first, the same order as before), then missing in finder order (category order, then name), so
a translator works through one category at a time. Categories use the finder's labels.

Outdated rows also show the English words added plus removed since the translation's source
revision (a replacement counts twice). Only visible rows load history, after a short scroll
debounce, with two worker jobs at most; leaving view cancels them. History parsing and the exact
word comparison run in workers. Successful counts are cached per device, keyed by hash, source
revision, and current English text; unavailable history has a retry action. `?sort=small` puts
known counts first, ascending, and unknown/missing rows last. The sort is preserved on return.
Category choices include fully translated categories with a zero work count. Unknown category
URLs stay scoped to zero rather than showing unrelated totals.

State is in the URL: `?lang=` (default: the first available language, never written), `?cat=` (category id),
`?q=` (name, hash, or category; typing is debounced into the URL) and `?state=outdated|missing`. Picking a
language pushes history; filters replace. Translators see only their assigned languages and no coverage;
editors and maintainers see every language plus a coverage table (translated, outdated, missing) that also
picks the language: a side rail when the page has room, otherwise a "Coverage" popover. Its totals
count only the selected category (labelled "<Category> only", otherwise "All categories"); counts are
built once per language for every category, so switching the filter is a lookup. The Outdated and
Missing counts agree with that scope. Maintainers can switch coverage to a dense category ×
language matrix showing translated / outdated / missing, with horizontal scrolling inside the
table on narrow screens. Editors keep the language view. This page does not change saved
translations; only derived counts are cached, and roles are still enforced by the Worker.

The list is virtualized (fixed rows, a bounded DOM window, one tab stop). Up and Down move the selection,
Page Up, Page Down, Home, and End jump, Enter opens it, and Enter in the filter opens the first match. Back
from the editor restores the language, filters, selection, and scroll position for that history entry.

Queue mode: a row (or Enter in the filter) starts a work-through queue of the rows shown, at that
row, on the shared model in `features/queue` (frozen membership, session storage, the queue id in
the history entry's state; the URL is unchanged, and reload, Back, and Forward keep it). The editor's
pane header then shows the shared control: "Translations" (Leave: back to the same view, at the
same row), the position ("12 of 148", a menu of every entry with Rebuild queue), and Previous/Next,
also on Alt+PageUp and Alt+PageDown. An entry is done when its saved translation is current, the
tab's own rule: a saved translation reads "Done · 147 left" at once and Next goes to what followed
it; an entry that falls behind later does not join an open queue (Rebuild queue asks again). Next
on the last entry ends the queue ("End · 2 skipped", Revisit). Previous and Next are plain links,
so the leave guard, drafts, and conflicts apply as for any navigation. Another language, the
finder, or a copied link is an ordinary visit (the control shows the queue paused, with Resume). A
row for an enhanced version with text of its own opens on its base's page with `variant=` (a plain
link would redirect to the base's text).

On a non-English tooltip, outdated translations show English changes in the Source panel. A
single toggle switches to current English and remembers the choice locally. Translators do not
see Compendium panels. For other roles the desktop right pane shows English OR the Compendium
under two tabs in the pane's header (English first, remembered per device); the hidden one is not
rendered, so it does no work. Phones keep their one row of panel tabs; there and in the narrow toggle layout the Compendium is rendered only while it is the open view, and its tab's dot shows only then.
Canonical alias redirects preserve a valid requested language, while dropping line and variant
highlights tied to the old route.

Editable translations have an optional, initially collapsed markup toolbar above the editor.
Its open/closed preference is stored locally. Choose an inline format, icon, line style, table,
link or title and insert it at the cursor; inline formats and references wrap selected text, and
tables turn selected lines into rows. Icons and line styles are inserted at the selection's
active end without replacing text. Link URLs and title names are placeholders and must be edited.
The toolbar is absent in read-only views.
To preserve the existing markup grammar, the toolbar declines insertion inside or across existing
tokens, incomplete markup, variables and table boundaries. Link and title labels containing `[`
are also declined because the reference parser would interpret that bracket as part of the target.
Declaration and block boundaries and lines joined or affected by comments, variables or math are
conservatively protected. Plain text in title bodies remains editable with the toolbar. Line styles
are declined when the renderer cannot consume another marker on that line or table row; links are
declined in table cells because the existing renderer cannot preserve their destinations there.
Harmless resolved imports and URL variables do not block unrelated text. Unresolved or structurally
complex expansions, and expansions that change comment boundaries, prevent insertion because
their renderer effects can span other authored lines.
Edit existing markup directly when a toolbar operation is declined.

Outdated order and the red "exported in English" flag use the same strict greater-than-90-day
revision gap as core export, not wall-clock time. Exactly 90 days remains translated.

Run root tests targeting this folder and `packages/core/src/status/status.test.ts`.
For the rendered touch-target and alias regression, run the web Vite server with
`VITE_API_URL` set to a non-production dummy URL and open `/test/translator-phone.html`
at a phone width. The fixture uses synthetic in-memory data and blocks network connections;
the page displays PASS with measured heights or an explicit failure.
