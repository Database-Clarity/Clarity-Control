# Translation worklist

`translationQueue` (core) classifies every tooltip × language as `missing` (English exists,
no saved translation), `outdated` (known source revision older than the current English) or
`current`. Aliases and tooltips without English are never listed. Translations without a
known `sourceUpdatedAt` count as current: missing source metadata is deliberately not guessed.

The page filters Missing (default) · Outdated · All via `?status=`, a language via `?lang=` and
a search via `?q=` (name, hash or saved text). Translators see only their assigned languages;
everyone else sees all of them. Each card is a single tap target linking to
`/t/<hash>?lang=<language>`; "Open next" opens the first listed entry that still needs work.
Lists render 50 cards at a time.

On a non-English tooltip, outdated translations show English changes in the Source panel. A
single toggle switches to current English and remembers the choice locally. Translators do not
see Compendium panels; other roles can open the Preview tab on phones to see them.
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

Expand English changes on an outdated card to load tooltip history lazily. Match the English
revision timestamp, not the commit date. Search up to 20 pages (600 commits); if unavailable
or not found, show a labeled current-English fallback, with explicit errors and retry for
request failures. Collapse or navigation aborts outstanding requests.

Run root tests targeting this folder and `packages/core/src/status/status.test.ts`.
For the rendered touch-target and alias regression, run the web Vite server with
`VITE_API_URL` set to a non-production dummy URL and open `/test/translator-phone.html`
at a phone width. The fixture uses synthetic in-memory data and blocks network connections;
the page displays PASS with measured heights or an explicit failure.
