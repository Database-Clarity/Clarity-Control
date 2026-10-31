# Weapon section inventory (read only)

Run on Node 24 from the repo root:

```sh
node scripts/weapon-section-inventory/inventory.mjs /path/to/editor-data/tooltips
node scripts/weapon-section-inventory/inventory.mjs /path/to/bundle.json
```

The only output is a JSON report on stdout. The script never writes data. It scans
all JSON strings recursively, including every language, reserved hashes, globals,
import/export libraries and legacy editor fields. It lists each active section's
source line and proposed ordinary bold heading, together with its containing
original and proposed text and input file SHA256. Comment examples are excluded;
comments and every body remain in the proposal. Unknown names stay as authored;
legacy abbreviations become readable names; `other` becomes `Other weapons`.

This is an inventory and review aid, not a migration or a publisher. Review each
containing description before applying any proposal through normal editor saves.
It reports authored sections once at their source; imports can display that same
source in several descriptions. It does not evaluate variables or expand imports.
Pass a pinned snapshot of the complete editor-data tree or its generated bundle
and record its source commit; an old fixture scan is not a current-data inventory.
