# Independent Compendium CSV acceptance

From the repository root:

```powershell
node scripts\compendium\coverage\run.mjs --html-dir '<existing HTML download directory>' --refresh
npx vitest run --config scripts\compendium\coverage\vitest.config.ts scripts\compendium\coverage\compare.test.ts
```

The HTML directory must contain `compendium-1027-landing.html` and
`compendium-1027-<gid>.html` for every included Landing tab. All CSV downloads are cached
inside this folder's ignored `downloads/` directory, never in the shared checkout.
Omit `--refresh` to reuse them. The gviz request explicitly sets `headers=0`;
otherwise Google silently guesses header rows and combines their text.

`compare.ts` derives expected named rows solely from CSV and core layout
configuration. It never imports the HTML parser. It retains full multiline names,
all configured description columns, duplicate-name multiplicity, and punctuation.
Only whitespace is normalized during comparison. The acceptance harness separately
parses HTML and writes `report.json`, including every missing/unexpected row and
complete expected/actual text. Any difference or tab error fails acceptance.
The Landing inventory is also discovered independently from its bootstrap records.
If the core parser cannot load, a fresh blocked report still records the independent
CSV counts and exact loader error; unmeasured parsed totals/mismatches are null.
The report includes physical CSV record numbers and spreadsheet parser row numbers;
blank-row omission means these numbers need not agree.

CSV exposes merged values only in their top-left cell. Explicit sheet conventions
are therefore necessary: parallel Exotic Armor perk aliases share Notes; archived
consecutive energy-cost mods share descriptions; grenade enhancement variants share
their base grenade cooldown; artifact cards use the next row and consume it once.
Single-row season headings are not cards. Prismatic's unnamed glossary guidance is
not part of its preceding named entry, while its multiline Shared Abilities labels
own subsequent ability rows. These conventions are tested independently; no
expected text is copied from parsed HTML or adjusted to suppress report failures.

Landing is explicitly navigation-only (zero named entries). An empty CSV, malformed
quoting, unknown layout, absent named data, missing source file, missing configured
tab, network error, or non-CSV response cannot silently pass. Without the HTML
directory environment variable, the live acceptance test is skipped, not marked as
a successful full-tab comparison.

The owner's amended scope excludes names containing the literal, case-sensitive
uppercase substring `OLD`. `Old` and `old` remain included. The report lists the
six configured uppercase-OLD tabs as intentionally excluded, not mismatches.
They are neither parsed nor compared; previously downloaded CSVs may remain cached.
