# Published legacy history

Run `python scripts/legacy-history/generate.py SOURCE_BARE_REPO GENERATOR_BARE_REPO EMPTY_OUTPUT`.
Sources are Database-Clarity/Live-Clarity-Database and Description-data-generator on GitHub.
The script pins the published converter cutoff, the reviewed alias mapping, and the migrated
tooltip inventory. It reads both raw published file names, never intermediate authored states.
It writes deterministic UTF-8 JSON, one file per existing canonical tooltip, plus a checksum manifest.

Each source hash has an independent lane. Exact hashes are restore-verified; reviewed sandbox
aliases are displayed with provenance but cannot restore. Frame aliases, legendary frames,
enhanced frames, and name aliases are excluded. Exotic frames remain ordinary exact identities.
Language absence differs from an empty string. Only consecutive identical text maps deduplicate;
deletion and reappearance remain events. Missing whole-file snapshots are gaps, never deletions.
Metadata comes from the GitHub repository's commit objects (author, author date, and full message).
This is a text projection, not a lossless archive of legacy metadata or secondary text.

Generate twice into separate empty directories and compare every byte. Before publication,
an independent reviewer must verify the exact staged tree, counts, exclusions, and 20 source
samples. Abort if remote `legacy-history` exists. Create one parentless commit and push that
new branch normally; never force, update another branch, or add a workflow. Pin the resulting
commit in the web client. The manifest SHA-256 values authenticate each tooltip's bytes.
