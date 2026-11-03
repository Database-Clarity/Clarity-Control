# @clarity/core

Pure TypeScript shared by browser and Cloudflare Worker. Runtime imports use only
Zod and Web APIs (Web Crypto SHA-256); Node imports are confined to tests and the
fixture refresh utility. Source exports are intended for the web/worker bundlers.
The standalone test toolchain supports Node 20.19+, Node 22.12+, or Node 24+.
Node 20 is the batch-1 CI runtime; patched Vitest 4 retains that support.

```powershell
cd packages\core
npm ci
npm test
npx tsc --noEmit
```

## Public API

- `validateText(text, lang, globals?, requireEnglish?)` returns source-ranged
  `{severity,message,from,to}` issues using the same markup parser as preview.
  Unknown variables/titles warn; parser/import errors and empty English block saves.
  `validateTooltip(tooltip, globalsForLanguage)` checks every stored language and
  missing English, attaching hash/language to each issue. Reserved declaration
  tooltips 0-3 are exempt from the English-description requirement.

- `parseMarkup(text, globals?)` returns `{ lines, diagnostics }`. `lines` uses the
  converter's structured line/span/table format; editor validation and preview use
  the same parser. `globals` holds raw selected-language `variables` (hash 2),
  `titles` (hash 3), optional `imports` (raw text keyed by tooltip hash; `1` or
  `global` supplies global exports), and optional `type` (legacy category type for
  enhanced/catalyst/exotic conditional blocks). Cross-tooltip imports now read
  main text only; `import self` reports the removed secondary-editor dependency.
  Stat formula spans are removed. Numeric `${...}` arithmetic is interpreted
  without `eval`/`Function`; the runtime has no converter/lodash dependency.
  Missing imports/variables produce visible diagnostics. Browser languages use
  `markupLanguage(lang)` to map legacy Chinese keys to BCP-47.
  The MIT-attributed port is checked against pinned converter 1.0.55 on every
  stored language of 2,760 untagged entries in **both** real database fixtures
  (5,520 comparisons), normalizing only secondary := main and stat-formula removal.
  Reserved help tooltip 0 deliberately differs: its three scoped bodies all render
  under ordinary headings, checked separately in the same fixture test.

- `tooltipSchema`, `langTextSchema`, `permissionsSchema`, `pushedSchema` and
  their inferred types validate persisted data without silently stripping fields.
- `migrateLegacy(database)` accepts the complete legacy intermediate database and
  returns `Tooltip[]`. Unknown authored fields fail validation.
- `contentHash(tooltip)` returns a Promise of a lowercase SHA-256 hex string.
  Object keys are canonicalized; text, metadata and array order (including
  `associated`, whose authored order is meaningful) are significant. `stableStringify` accepts finite JSON data
  (optional object properties with `undefined` are omitted).
- `publishableHash(tooltip)` uses the same canonical JSON/SHA-256 algorithm, but
  hashes the per-language text as exported (a translation that falls back to English
  hashes as the English text, and a `fallback` language list is added only when some
  language falls back, so other digests are unchanged), associations (authored order),
  and custom facts. A language only falls back to English when the English text is non-empty.
  Pass the generator `aliases` and the aliases that resolve to the tooltip are folded in too
  (sorted `[hash, kind]` pairs, omitted when there are none), so a new or retargeted alias makes its
  canonical pending. **Rollout:** every canonical that already has aliases, and every tooltip whose
  translations currently fall back to English, gets a one-time new digest and shows as pending once. `live/pushed.json` stores these digests: metadata-only edits do not mark
  a tooltip pending. Identity, timestamps, author credits, source revisions,
  legacy metadata and snapshots are excluded; they remain stored in the tooltip.
- `merge3(base, head, next)` returns `{ ok: true, merged }` or
  `{ ok: false, conflicts: [{ field, base, head, next }] }`. Each language's
  complete `LangText` is atomic, preventing text and author/timestamp mismatches.
  Association membership uses set merge: union additions, remove an original member if
  either side removed it. Order never conflicts: if one side kept the base order the
  other side's order wins; if both reordered, `next`'s order is kept for surviving
  members and `head`-only additions are appended in `head`'s order. All other top-level fields are atomic, including
  snapshots and legacy metadata. A hash mismatch is an error.
- `aliasesSchema` validates generic `{ to, kind: 'sandbox' | 'frame' }` aliases;
  `resolveAlias(hash, aliases)` follows chains and rejects cycles.
- Compendium APIs live in `src/compendium/`. `parseCompendiumTabs(html)` reads
  the Landing tab switcher without executing scripts. `parseCompendiumSheet`
  builds the physical row/column grid (including omitted empty rows and
  row/column spans), detects header names on each fetch, applies the small
  per-tab synonym/layout overrides in `config.ts`, and resolves stylesheet
  classes plus inherited inline styles to normalized runs. Class names and HTML
  are never persisted. Parallel tables and artifact name/description cards are
  supported. Three trimmed real htmlview fixtures and their golden outputs are
  checked offline; `test/compendium/refresh-fixtures.mjs` documents their source
  and trimming. Set `COMPENDIUM_FIXTURE_DIR` to the downloaded full-tab fixtures
  to run the optional all-tab smoke test.
- `compendiumDataSchema` validates `{ fetchedAt, tabs: [{ gid, name, rows }] }`.
  Each row has `rowIndex`, `name`, `nameNorm`, optional `section`, and styled
  `cell: { plain, runs }`. `Tooltip.compendium` is optional (existing migrated
  tooltips have none) and stores `{ gid, rowKey, section?, snapshot, snapshotAt }`.
  `resolveCompendiumLink` distinguishes exact `ok`/`changed`, unique normalized
  `moved`, ambiguous or content-similar `candidates`, and `missing`. Duplicate
  names use section and then snapshot similarity; ties require confirmation.
  `snapshotCompendium` records confirmed/resolved locations; `sameCell` detects
  text and styling changes independently of class names or adjacent run splits.
- `diffCompendium` matches complete words across run boundaries, preserving all
  source styles and distinguishing added/removed text from style-only changes.
  The separate Compendium-data repository runs the bundled core parser outside
  the Worker CPU budget; see `scripts/compendium/README.md` in the editor root.
- `exportLegacy(tooltips, now, catalog?, aliases?)` returns legacy entries keyed by hash.
  Supply canonical tooltips only. Every frame and sandbox alias is exported as a
  reference stub `{ hash, aliasOf, aliasKind: 'frame' | 'sandbox', ...ownFacts }`
  (`LegacyAliasStub`; `isLegacyAliasStub` narrows the `LegacyExportEntry` union).
  `aliasOf` is the final canonical hash. `ownFacts` (`name`, `type`, `itemHash`,
  `itemName`) are only the alias's own catalog facts: required for frames when a catalog
  is supplied, present for sandbox aliases only if the catalog has them. Stubs carry no
  editor text, `associated`, upload/update metadata or legacy fields; canonical entries
  are unchanged. Consumers must resolve `aliasOf` to the canonical text, so the converter
  that understands stubs has to be published before push-live writes them to the real
  `converter` branch (an older converter would drop frame aliases). Alias tooltips and
  cycles fail explicitly.
  `associated` lists the tooltip's associations in authored order, resolved to canonical
  hashes, deduplicated to the first occurrence, without the entry's own hash, and omitted
  when empty (canonical entries only; stubs carry none).
  `now` is nonnegative integer epoch milliseconds, used only when no legacy upload
  timestamp exists; export does not manufacture new edit authorship. Main text
  supplies **both** legacy editor fields. A translation with known
  `sourceUpdatedAt` more than 90 days behind `en.updatedAt` exports English text
  and English edit metadata. Exactly 90 days does not fall back. This measures
  source-revision age, not time since translation or wall-clock age. Unknown source
  revision or absent English retains the translation.

### Manifest join

Tooltips do not store generated `name`, `type`, `itemHash`, `itemName`, folders,
or enhanced pairing. Provide the optional third `catalog` argument to
`exportLegacy` to restore converter manifest fields (stat fields remain omitted):

```ts
const entries = exportLegacy(tooltips, Date.now(), {
  '123': { name: 'Perk', type: 'Weapon Trait', itemHash: 456, itemName: 'Weapon' },
});
```

With a catalog, any missing manifest record throws (custom tooltip facts can
supply their own name/category). Without one, export returns authored entries,
not a complete converter database. Caller owns `databaseSettings`, loading manifest
aliases, and selection of canonical tooltips to publish.

## Legacy field inventory

| Legacy field                                                  | v2 destination / treatment                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `hash`                                                        | `hash`; map key must agree, unsigned 32-bit integer                                            |
| `editor[lang].main`                                           | `text[lang].text`                                                                              |
| `editor[lang].secondary`                                      | deliberately discarded; export uses main                                                       |
| `updateTracker.descriptions[lang]`                            | `text[lang].updatedAt/updatedBy`; original also retained in `legacy.updateTracker`             |
| `updateTracker.stats`                                         | deliberately discarded with the unused stat editor                                             |
| `uploadedBy`, `lastUpload`, `inLiveDatabase`, `uploadToLive`  | `legacy` compatibility metadata                                                                |
| `stats`, `importStatsFrom`, `duration`, `activationCondition` | deliberately discarded; no v2 schema fields or export output                                   |
| `name`, `type`                                                | excluded manifest facts; reserved custom hashes 0-3 preserve these as `custom.name/categoryId` |
| `itemHash`, `itemName`                                        | excluded manifest facts, supplied at export by caller                                          |
| `databaseSettings.folders/enhancedPerks`                      | excluded manifest structure; caller-owned                                                      |

Migration keeps upload flags without interpreting them as v2 permissions or
pushed state. All stat data, links, calculation parameters and stat tracker
credits are intentionally dropped by owner decision; the legacy input-only
validator still recognizes their original shapes so real fixtures remain
validated without silently accepting unknown fields. Missing edit
timestamps/authors become epoch/empty
author, not guessed upload metadata. Legacy has no reliable source revision:
`sourceUpdatedAt` is intentionally absent after migration. Orphan language
trackers without editor text remain in compatibility metadata, retaining credits.
The metadata copy is historical; text edits export the current `LangText` tracker.

## Languages

`en`, `de`, `es`, `es-mx`, `fr`, `it`, `ja`, `ko`, `pl`, `pt-br`, `ru`,
`zh-chs`, `zh-cht`. Confirmed against Description-converter's
[`src/data.ts`](https://github.com/Database-Clarity/Description-converter/blob/153b87bff62263b28ad6e70bd229448c383196aa/src/data.ts).
The pinned databases currently contain only English editor text, but retain some
historical Korean/Chinese tracker credits.

## Golden fixtures and intentional differences

Fixtures are full untrimmed public intermediate/live databases (~2 MB each) and
the generator template (~0.4 MB). Tests never fetch the network. The provenance
file pins source commits and SHA-256 checksums. Refresh from this directory:

```powershell
node test\refresh-fixtures.mjs
npm test
```

Review the changed fixtures and explicit branch-drift values before committing.
The refresh utility derives drift from the two raw inputs, never the mapper.
Refresh refuses a
fixture over 5 MB so gzip support must be added explicitly before larger data is
committed.

The branches are **not identical input/output**: all 2,761 hashes have different
upload timestamps, and some differ in text, authorship/tracker timestamps,
publication flags, import-stat links, stats, or generated facts. Pretending
intermediate can reproduce those live values would silently discard newer work.
The golden tests therefore:

1. Assert live -> v2 -> live equals every original field for every hash,
   changing **secondary := main and removing all stat fields/stat trackers**.
2. Independently assert intermediate -> v2 -> export equals **every original
   intermediate field** for every hash, except the same explicit secondary and
   stat-removal changes. No exception
   file can waive a migration/export failure, even if all metadata differs.
3. Compare remaining authored text against live (12 differing hashes), with explicit before/after
   values and a reason per hash in
   [branch-drift.json](test/fixtures/branch-drift.json). Upload metadata and
   generated facts are excluded only from this cross-branch comparison, never
   from the two exact full-field roundtrip assertions.
4. Confirm only reserved hashes 0-3 are absent from the generator template.

Schemas and unit tests additionally prove removed stat fields (including optional
`duration` and `activationCondition`) cannot persist in v2 or leak into export,
and cover synthetic translations including the exact 90-day boundary.

## Retired weapon sections

Perks show their entire description everywhere. `MarkupLine` has no `weaponTypes`,
`weaponBlock` or `weaponOther`; specialization, scoped validation and scoped-syntax
conversion APIs have been removed. Existing `<weapons Name>` / `</weapons>` and
`< weapon type (HC) >` / `< (other) >` / `<$$>` delimiters remain readable input.
The parser emits ordinary bold headings in source order and retains every body,
including fallback blocks, unknown names, imported text and nested titles/tables.
Legacy abbreviations expand for readable headings; `other` becomes `Other weapons`.
Normal category conditionals, comments and import rules still apply.

`weaponSectionHeadings` is the compatibility rewrite used on prepared parser text;
it does not edit stored descriptions. The read-only inventory tool in
`scripts/weapon-section-inventory` proposes raw-source heading changes for review.
`exportLegacy` continues exporting raw authored main text into both fields; the
matching converter change is required to render all bodies in published output.
Catalog facts and alias stubs exclude retired weapon facts and editor-only owners.
Existing legacy database label settings are accepted as inert input and push-live
preserves live settings without loading or rewriting labels. The unrelated legacy
stats schema retains its historical weapon-type keys for migration compatibility.
