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

Revision popovers defer layout of offscreen language comparisons until they enter
the scroll viewport, retaining their complete diff text in the DOM. Explicit local
symbol/Korean/Chinese font fallbacks avoid expensive cold fallback searches; the
language faces cover only their Unicode ranges so Latin markup keeps its metrics.


An explicit Worker 404 saying the tooltip did not exist at an immutable commit is
cached as an absent revision. Deletions show the previous text removed; restorations
show the restored text added. Deleted versions cannot be restored as drafts.
Other HTTP/network failures remain retryable. Rows show the commit subject only;
full pages mount four rows per animation frame to keep cached opens responsive.

A changed bundle head or authenticated cache identity resets the open list to page
one, so saving after paging cannot mix older pages with the newest revisions.
