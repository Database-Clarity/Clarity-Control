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

On a non-English tooltip, each variant keeps its Compendium panel with the preview. On phones,
open the Preview tab to see it; the Source and Translation tabs remain available.
Canonical alias redirects preserve a valid requested language, while dropping line and variant
highlights tied to the old route.

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
