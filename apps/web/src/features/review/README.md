# Review saved changes

`#/review` compares each canonical saved tooltip's core `publishableHash` with
the bundle's pushed marker. Local drafts and metadata-only edits do not count.
Categories follow registry order; enhanced tooltips with their own authored text
remain separate review items. The left column (`ReviewQueue`, a fixed-height virtual list) groups
the changes by category with counts and a checkbox per row and per group (the publish selection);
marker-only leftovers are one collapsed group at the bottom that never takes part in a group
select. Only the open change requests history. Up/Down (outside controls), the list's own keys,
and the phone's ‹ › walk the shown rows without wrapping; Space includes the open change.

Selection survives navigation, but only still-pending hashes are submitted.
"Work through N selected" and "Work through all N shown" (under the filters) open those changes
in the editor as a work-through queue (`features/queue`); a change counts as done once it is saved
again. Leave comes back with the filters and open change, and picks the selection again only for
rows still saved as they were when the queue began.
Editors and maintainers may push any number at once (the Worker reads them in batches). "Push selected"
first opens a confirmation listing every tooltip going live (Enter confirms, Esc cancels; a held key or a
double-click cannot confirm twice). The request includes the
reviewed content digests; a newer saved version causes a 409 rather than silently
publishing unreviewed content. Successful responses update the local marker view
only; the bundle is deliberately not reloaded after a push, because bundle generation
and CDN caching lag and a reload would resurrect pre-save text. Manual refreshes also
keep this tab's saved tooltips on top of a stale fetched bundle (`stores/savedOverlay.ts`)
until it catches up or 15 minutes pass; a full page reload in a stale window still shows
the CDN copy, and the server's 409 protects live data.
Tooltips with no generator entry that are not custom are listed as unpublishable
(the Worker would 422) and cannot be selected.

Acknowledgments and the submission lock live in review-specific tab memory, outside
the route's loading/unmount lifecycle. There is at most one acknowledged digest per
tooltip, paired with its pre-push bundle marker. It applies only while that marker
is unchanged; a caught-up or different marker, or removal of the tooltip, retires it.
Changed saved text is still compared by digest and becomes pending. A full page
reload clears this memory; no cross-session persistence is promised. The latest
success/error notice survives route remounts until the next attempt or account/role
change. Server acknowledgments remain valid across account changes, but notices
and selections are cleared; an outstanding request keeps its lock until settlement.
Selection also clears when the saved snapshot changes. Hashing aborts submission
if the page unmounts, identity changes, or saved data is replaced before the request.
A bundle refresh error (manual refresh) is reported by the data-loading shell, separately
from a publish failure; retrying data loading restores the acknowledged review view.

`GET /history/:hash?live=1` supplies the exact last pushed authored snapshot.
The worker commits `live/tooltips/<hash>.json` with `live/pushed.json`, using the
same immutable data version exported to the target branch. A save between export
and marker recording cannot contaminate the diff. Pre-snapshot markers are recovered
by finding a historical tooltip with the same publishable digest (up to 300 commits);
failure is explicit, never a comparison against guessed text.

The comparison is authored pushed text, before export-time translation fallback.
No live marker means no recorded live baseline, not proof that the legacy database
never contained that hash. Partial live-write failures retain the worker's explicit
error details and must not be interpreted as "nothing was published."

## Publisher mode (flag `VITE_PUBLISHER_ENABLED=1`, OFF by default)

With the flag off nothing below runs and `/push-live` behaves exactly as described above. The flag is
build-time; it is turned on only together with the Worker's `/publish` writes (design step E,
`.agents/reports/actions-publisher-design-v2.md` §2/§3).

- Confirming creates one operation `{opId (ULID), hashes, expected digests, previous markers}` and stores it
  in IndexedDB (`clarity-publisher`, separate from the drafts database) BEFORE the first request. Every
  retry (lost 202, 5xx/offline backoff, reload, another tab) re-sends the same opId and byte-identical
  body; the Worker is idempotent per opId. If the record cannot be stored, nothing is sent.
- Statuses per operation: Sending… (stored, not yet acknowledged) → Publishing… (202) → Published / Already
  live (`done`/`unchanged`: markers update through the same acknowledgment overlay as before) / Changed
  (`stale`: nothing went live) / Rejected / Failed. A 400 or a pending operation the Worker no longer knows
  asks `/publish/status` or re-sends the same body, never a new opId. 401 pauses until sign-in.
- Polling is one `GET /publish/status?opId=` per pending operation: 4 s for 30 s, 10 s to 3 min, 30 s to 30 min,
  then 60 s; paused while the tab is hidden; tabs share one stream (`polledAt` claims in the store).
- After 3 minutes pending the line becomes Waiting with a Retry button, and the tab auto-kicks ONCE
  (`autoKicked` is stored, so a reload never repeats it). Retry kicks again at most every 30 s. Requests that
  other editors queued (`bundle.publishQueue`, informational) appear as one "N publish requests waiting"
  line with Retry.
- Tooltips inside a queued operation show "publishing…" and cannot be selected again. Finished operations
  stay 24 h (they rebuild the acknowledgment overlay after a reload) and can be dismissed.
- Only editors/maintainers see any of this; the driver is inert for other roles.
