# Lost-tooltip artifact

Generate offline from read-only local clones (full history required):

```powershell
node scripts/lost-text/generate.mjs D:/GitHub/Live-Clarity-Database D:/GitHub/Description-data-generator apps/web/src/features/lost-text/lost-text.json 100d9e645f71c3edf343b45dcf2e74395e7b724f fbb6b2d54720c8abda67eb7c915d7be487b0c087 56504efbaa5961d39b77d05354ef9161e0b45bc8
```

Omit the last three arguments to use origin/editor-data, origin/intermediate and
HEAD in the generator clone. The artifact pins all three resolved commits, has no
wall-clock timestamp, and is checked in like research-hints.json. Regenerate when
the editor-data revision changes; stale records remain viewable, but current saved
nonempty languages are excluded and existing local text cannot be overwritten.

The script scans main text in every supported language, first-parent v2 per-file
history followed by intermediateDescriptions.json. Zero-byte snapshots are
excluded. Secondary text, removed current records, other branches and unobserved
history are outside scope. It records the last nonempty revision and the adjacent
observed blank revision with author/date, not an inference about intent.

Historical bungieSnapshot equality takes precedence. Legacy intermediate records
lack historical manifest snapshots, so pinned current manifest equality is used
as copy evidence only when no positive authorship stamp exists. An authored text
matching only today's manifest is unclear (Concussion); a positive stamp with
differing text is human (Ricochet). Zero trackers alone are never human. Comments
and import-only text are placeholders. This classification is conservative review
guidance, not proof of historical accuracy. No browser or worker history scanning
and no source-repository writes occur.

The page has its own navigation entry. Non-translators may view; editors and
maintainers may recover/dismiss. Recovery uses History revert + replaceDraft;
only the selected language is changed, then normal Save review is required.
Dismissals use user-scoped localStorage fingerprints of clearing/source revisions
and recovered text. Changed history reopens the record. Storage failures are
shown and never silently treated as persisted dismissals.
