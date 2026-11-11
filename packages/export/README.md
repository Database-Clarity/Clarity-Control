# @clarity/export

Turns the published tooltip data into the files partner apps download.

Today it builds the **legacy files**: the eight formats the old converter made (`clarity`, `dim`,
`crayon`, `foundry`, `lightGG`, `braytech`, `vaultZero`, `clarityV2`), byte for byte the same as
the held converter. The code in `src/converter/` is a copy of that converter (MIT, see
`PROVENANCE.md` for where it came from and every change). Configurable exports come later.

The package has no Node-only code, so the same engine runs in a GitHub Actions job and in a
browser Web Worker. `npm run build --workspace @clarity/export` bundles it into one file,
`dist/engine.mjs`.

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
- **`bungieIdentical(input, inventoryItems)`** lists the tooltips whose English text is exactly
  Bungie's own description (from the manifest's `DestinyInventoryItemDefinition`). Most presets
  leave those out; `crayon` and `vaultZero` keep them. Without `identical`, nothing is left out
  for this reason.
- **`legacyPresets`**, **`deployedLegacyPresets`**, and **`legacyFileName(preset)`** give the
  preset names and their file names with the exact case (`lightGG.json`, `vaultZero.json`).

## Checks

- `test/parity-*.test.ts` build every preset from three inputs (the published file, the editor
  data, and a fixture with every markup feature) and compare each file's sha256 with the held
  converter's. Any byte change fails. If a change is meant to alter the output, it is a decision
  for the owner, and the hashes are updated in the same change with the reason.
- `test/engine.test.ts` covers one failing file next to working ones, `versions.json`, the safe
  math, and that nothing in this package runs text as code.
