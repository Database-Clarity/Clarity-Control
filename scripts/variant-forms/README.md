# Variant forms audit (read only)

Run on Node 24+ from the repo root, with a directory holding `bundle.json` (editor-data bundle) and the
generator's `items.json`, `categories.json`, `aliases.json`:

```sh
node scripts/variant-forms/audit.mjs /path/to/dir > audit.json
```

For every variant (a non-alias item whose canonical hash is another item), it reports per category and
language whether the stored text is empty, a pure `import main from <base>`, identical to the base, rendered
like the base, or its own text, and the resulting form from `features/tooltip/variants.ts`:

- `derived`: renders, in every language, like the BASE text read with the variant's own category type.
- `override`: anything else (own text, or empty where the base has text).

Every derived variant is also cross-checked against the published converter (the exporter's renderer):
`derivedExportDiffers` must be empty. The script never writes data and changes no export.
