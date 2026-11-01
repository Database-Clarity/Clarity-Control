# Read-only Browse geometry regression

Run the web Vite development server with `VITE_API_URL` unset, using an
unused local port. Open `/test/browse-scroll.html?workspace=review` in a
real browser at **390x844** and **390x500**. Repeat with
`workspace=compendium` and `workspace=editor&long=true`.

The fixture mounts the real Layout, Editor and pending-change Review.
Compendium categories are synthetic sidebar-store entries; its content
is a placeholder, not a matching or guidance session. All data is
in-memory, drafts are empty, authentication is absent and fetch throws.
Do not edit, save, sign in or trigger decisions.

Read the hidden `#result` output after loading. `PASS` includes actual
top/end rectangles, clientHeight, scrollHeight, scrollTop, final-link
bounds, Close bounds, selection and network requests. The assertions
require one viewport-bounded body, reachable final link, stationary
Close/background, no horizontal overflow, 44px queue targets, focus
containment/restoration and unchanged selection after close/reopen.
Failures are explicit and the readiness wait is bounded to five seconds.
The fixture leaves Browse open at the top for a screenshot; scroll its
body to the end for the companion capture.

At **1440x1000**, repeat the queues for desktop density. Use
`workspace=editor` without `long=true` for the representative short
English tooltip, German Source-to-English fallback, sticky phone panel
tabs and desktop divider. The long shared-owner fixture deliberately
stresses sidebar sizing, not representative editor-header reachability.

The mounted navigation test checks structure and the stretch rule only.
It does not supply browser layout geometry. This fixture is the
permanent rendered regression; headless results do not imply physical
phone, IME or real-account clearance.
