# Tooltip history

Each tooltip and enhanced variant has a lazy-loaded history panel. The worker lists
30 commits per page for `tooltips/<hash>.json`, including GitHub login/avatar when
available and git author/date/message as fallbacks. Selecting a commit loads its
immutable full JSON, shows all language differences against the current local draft
(or saved tooltip), and exposes the complete historical record.

Revert requires confirmation and only loads a local draft through the normal
save service. It never directly saves or publishes. Existing local edits are replaced
only after confirmation; normal validation, metadata enrichment, merge handling and
persistent draft storage still apply. Translators restore only assigned languages
and cannot replace associations or other tooltip fields.

`services/history.ts` is the worker client shared with review and translations:
`getHistory(hash, page?, signal?)`, `getVersion(hash, commit, signal?)`,
`getPushedVersion(hash, signal?)`, and `pushSelected(hashes, expected)`.

History panels share a bounded memory cache keyed by signed-in user, bundle head and
hash (12 tooltips; 24 immutable revisions and 6 list pages each). List pages expire
after one minute and refresh on open while cached rows remain visible. Sign-in or
permission changes clear the cache. Hover intent starts fetching after 60ms and
leaving before intent cancels it; the popover opens after 120ms. After opening,
idle prefetch is limited to the newest two revision bodies, never another page.
Large language word diffs run in a worker; an exact before/after text fallback is
shown until the result arrives. Worker results retain at most 24 comparisons.

