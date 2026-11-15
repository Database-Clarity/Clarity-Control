# Owner acceptance after setup

This is an owner-run checklist, not evidence that acceptance has happened. Prefer
a separate scratch repository and App as described in [setup](OWNER-SETUP.md#7-local-development-without-touching-production).
Only the owner may authorize a real-data test. Do not use production as the live
target. A test push also writes `live/pushed.json` and a `live/tooltips/<hash>.json`
snapshot on the configured data branch; it is not confined to the test branch.

Before **any write**, record the owner-observed effective repository, `DATA_BRANCH`
and `LIVE_BRANCH` of the deployed Worker. Verify the actual deployment and App
installation through the owner's setup records or dashboard; there is no config
endpoint in this checklist. STOP if any target is unknown, if the live target is
production, or if `LIVE_BRANCH` is not explicitly `converter-v2-test`. Recheck
these targets immediately before pushing. The checked-in [configuration](wrangler.jsonc)
names `Database-Clarity/Live-Clarity-Database`, `editor-data`, and
`converter-v2-test`, with site https://database-clarity.github.io/Clarity-Control/v2/
and callback on https://clarity-editor-api.cboweris.workers.dev. Configuration
alone does not prove what is deployed or which API the loaded bundle uses.

1. Hard refresh the intended v2 page or use a private window: an older Pages
   bundle can remain cached. Start **Sign in with GitHub** from the intended
   editor page. Confirm return to that page and that the callback URL no longer
   exposes the session. Confirm the signed-in identity and expected role assigned
   to its numeric GitHub ID; for a translator also check **Editable languages**.
2. Make a harmless owner-chosen scratch edit, reload, and confirm the local draft
   survives. Open **Review and save drafts**, inspect the diff and validation,
   then **Save changes**. Check the data-branch commit: the real signed-in user
   is author and the GitHub App bot is committer. A local draft is not a saved
   change; review compares saved publishable content, not unsaved drafts or
   metadata-only edits.
3. Open **Review changes** (`#/review`), inspect the saved diff against the last
   pushed snapshot, and select exactly one owner-chosen record. Confirm the
   effective repository and `converter-v2-test` target again before **Push selected**.
   Inspect the target commit and exported record, and the data-branch marker and
   snapshot. Compare the snapshot and marker digest with the saved source version
   actually reviewed; record the relevant commit IDs and selected hash.
4. Sign out and check read-only behavior. Separately perform the owner’s physical
   phone and IME checks; desktop or synthetic checks do not establish these.

If a push reports `pushedRecorded: false`, the target write occurred but marker
recording failed. Other errors or lost responses may also follow partial writes.
Inspect the target branch, reported `liveCommit` if available, data commit,
marker and snapshot before any retry; rejection does not prove nothing changed.
For a stale reviewed digest, refresh saved changes and review the current version
again before deciding whether to retry. Do not blindly repeat the push.

The review-refresh fix preserves the success notice and acknowledged marker overlay
after a successful push. A publish can succeed even if bundle refresh fails. Inspect commits and markers
before acting; an apparently pending item or refresh error is not proof of failure.

Retain targets, time, selected hash, observed role/languages, commit IDs, marker
and snapshot comparison, outcome and sanitized error details. Never retain session
URLs, tokens, secrets or private keys in evidence.
