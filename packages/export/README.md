# @clarity/export

Turns the published tooltip data into the files partner apps download.

It builds two kinds of file:

- **Legacy files**: the eight formats the old converter made (`clarity`, `dim`, `crayon`,
  `foundry`, `lightGG`, `braytech`, `vaultZero`, `clarityV2`), byte for byte the same as the
  held converter, except for armour set bonuses (see "Set bonuses" below). The code in
  `src/converter/` is a copy of that converter (MIT, see `PROVENANCE.md` for where it came from
  and every change).
- **Format v1 files**: what a project's config asks for (which tooltips, languages, and keys, and
  how each symbol looks), in a smaller shape. See "Configurable files" below.

The package has no Node-only code, so the same engine runs in a GitHub Actions job and in a
browser Web Worker. `npm run build --workspace @clarity/export` bundles it into `dist/engine.mjs`
(the engine) and `dist/config.mjs` (the config schema, kept apart because it is large).

## Using it

```ts
import { buildAllLegacy, buildLegacy, bungieIdentical } from '@clarity/export';

const input = JSON.parse(liveDescriptionsJson); // { perks, databaseSettings }
const identical = bungieIdentical(input, manifestInventoryItems);

// One file:
const bytes = buildLegacy(input, 'dim', { identical }); // Uint8Array, write it as dim.json

// All files at the old URLs, plus versions.json:
const build = buildAllLegacy(input, JSON.parse(oldVersionsJson), { identical });
for (const file of build.files) {
  if (file.ok) write(file.name, file.bytes);
  else keepOldFileAndNotify(file.name, file.error); // the other files still update
}
write(build.versions.name, build.versions.bytes);
```

## Functions

- **`buildLegacy(input, preset, { identical })`** builds one file and returns its bytes (UTF-8).
  It throws when the preset name is unknown or the input is broken for that preset (for example
  an import of an export that does not exist, or an association to a tooltip the file leaves out).
- **`buildAllLegacy(input, previousVersions, { identical, presets })`** builds each file on its
  own. One file failing never stops the others: its result has `ok: false` and the `error`, and
  the caller keeps the old file. By default it builds the seven files that exist at the old URLs
  (`deployedLegacyPresets`); pass `presets: legacyPresets` to add `clarityV2`. It always returns
  the next `versions.json` too.
- **`nextVersions(previous)`** adds 0.0001 to `descriptions` (`2.0625` becomes `2.0626`), keeps
  any other keys, and writes the file as before (one-space indent, no newline at the end).
- **`bungieIdentical(input, inventoryItems, sandboxPerks?)`** lists the tooltips whose English
  text is exactly Bungie's own description (from the manifest's `DestinyInventoryItemDefinition`;
  for a set bonus also `DestinySandboxPerkDefinition`, when `sandboxPerks` is given). Most presets
  leave those out; `crayon` and `vaultZero` keep them. Without `identical`, nothing is left out
  for this reason.
- **`legacyPresets`**, **`deployedLegacyPresets`**, and **`legacyFileName(preset)`** give the
  preset names and their file names with the exact case (`lightGG.json`, `vaultZero.json`).

## Set bonuses

Armour set bonuses (owner 2026-11-11: "Set bonuses should definitely be added to legacy outputs,
the rest probably not") are tooltips keyed by their sandbox perk hash, in the generator category
`armor-set-bonus`. They have no plug, so apps look them up by the sandbox perk hash of the set's
`setPerks`. The legacy files write them like any other entry, with two differences from the held
converter, the decided cut-over exception of G-PARITY:

- their `type` is the legacy type name `Armor Set Bonus` (in the presets that write `type`);
- a set bonus whose text is Bungie's sandbox perk text counts as Bungie-identical (pass
  `sandboxPerks` to `bungieIdentical`).

Other sandbox perks stay out of the legacy files: their alias entries are skipped, as before.
Until cut-over the editor does not push set bonuses live (`isHeldSetBonus` in core), so the files
built by the held converter never contain them.

## Checks

- `test/parity-*.test.ts` build every preset from three inputs (the published file, the editor
  data, and a fixture with every markup feature) and compare each file's sha256 with the held
  converter's. Any byte change fails. `test/set-bonus.test.ts` lists the set-bonus diff exactly
  (fixture and real data) and checks every other byte. If a change is meant to alter the output, it is a decision
  for the owner, and the hashes are updated in the same change with the reason.
- `test/engine.test.ts` covers one failing file next to working ones, `versions.json`, the safe
  math, and that nothing in this package runs text as code.
- `test/v1.test.ts` covers the config schema and migrations, the build steps and references,
  each style, base/enhanced pairs against the editor preview, and real data in every style
  (same bytes twice, decoder round trip, and every tooltip equal to the editor preview).

## Configurable files

A project (one partner app or site) has a config with up to three files. The config is checked
with the strict schema from `@clarity/export/config`:

```ts
import { configSchema, migrateConfig } from '@clarity/export/config';
import { compile, newStyleFile } from '@clarity/export';

const config = migrateConfig(storedJson); // older schemas are brought up to date, then checked
const plan = compile(input, config.files[0], { catalog, identical });
write(`${config.id}/v1/${config.files[0].id}.json`, plan.bytes);
```

- **`configSchema`** refuses unknown keys everywhere, ids that are not path-safe (2 to 32 of
  a-z, 0-9, and -, starting with a letter; not `index`, `changelog`, `api`, `assets`,
  `well-known`, or `v` + digits), more than 3 files or 6 URLs per project, strings over 64
  characters or with control characters, and `keep` in the text shape.
- **`migrateConfig(stored)`** runs `migrations[n]` (schema n to n + 1) until the config reaches
  the current schema, then checks it. Schema 1 is the first, so there are none yet.
- **`immutableChanges(previous, next)`** lists what a save may not change: the project id, file
  uids the server did not assign, and the retained old URLs.
- **`unknownCategories(config, ids)`** lists category ids the catalog does not have (a notice,
  never a failure).

### What a file can choose

- **Data**: item categories, sandbox perks per item category (a sandbox perk belongs to the
  category of the item it is a perk of), frame aliases, languages, keys (`name`, `itemHash`,
  `itemName`, `type`, `lastUpload`, `uploadedBy`, `updateTracker`, `associated`), and whether
  tooltips equal to Bungie's own text are included. Nothing is in a file until it is chosen.
- **Shape**: `lines` (spans with class names, links, and titles) or `text` (one string per
  language).
- **Symbols**: each of the 16 icons, the enhanced arrow, bold, yellow, PvE, PvP, and element
  text is kept (lines only), dropped (its text stays), or replaced with text before and after.
  A symbol the file does not name is dropped and listed in a notice, so a symbol added later
  never appears in a file until its owner chooses it. Titles are kept, dropped, or written
  inline; links are kept, dropped, or written with a pattern such as `[text](url)`; blank-line
  spacers are kept or dropped.
- **Style**: `structured`, `markdown`, `discord`, or `plain` only fill these in for a new file
  (`newStyleFile`); every row can be changed afterwards. Legacy presets take no choices.

### How a file is built (`compile`)

1. **Resolve** every chosen tooltip with the whole database, exactly as the editor preview
   does: imports, variables, math, titles, and base/enhanced pairs `{{base}{enhanced}}` (an
   enhanced perk shows the second part, every other perk the first). Leaving a tooltip out never
   breaks another one that imports it.
2. **Rows**: categories, sandbox perks, frame aliases, Bungie-identical text, languages. Always
   left out: hashes below 50, an empty English text, and a tooltip with nothing visible.
   A tooltip with no catalog item is left out and listed in a notice.
3. **Keys**: only the chosen ones.
4. **References**: an `associated` hash that is not in the file is removed.
5. **Symbols**, as chosen above. Tables (retired, none in today's data) are not written.
6. **Encoding** (format v1, below).
7. **Bytes**: minified JSON, after checking that every reference resolves.

Legacy presets skip steps 3, 5, and 6 and build exactly as before. They refuse base/enhanced
pairs until the owner decides what the old files show for them.

### Format v1

```json
{ "texts": [{ "en": "Damage +10%" }], "items": { "123": { "name": "Perk", "t": 0 } } }
```

Each distinct description is stored once in `texts`; an item points at its text by index `t`.
An alias, a sandbox perk, or any tooltip with the same text shares that one entry. To get the
older per-hash shape (`{ "123": { "hash": 123, "name": "Perk", "descriptions": { ... } } }`),
copy `decoder/decode-v1.mjs` (about 20 lines, plain JavaScript) into your app:

```js
import { decodeV1 } from './decode-v1.mjs';
const items = decodeV1(await (await fetch(url)).json());
```

Apps can poll `/<project>/index.json` (`projectIndex`), about 1 KB, which lists each file's
sha256, size, and last update, and download a file only when its sha256 changes.
