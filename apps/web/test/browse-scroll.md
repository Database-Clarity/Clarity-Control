# Read-only Browse geometry regression

Run the web Vite development server with `VITE_API_URL` unset, using an
unused local port. Open `/test/browse-scroll.html?workspace=review` in a
real browser at **1440x1000**, **390x844** and **390x500**. Repeat with
`workspace=compendium`, `workspace=compendium-sample`,
`workspace=compendium-entry`, and `workspace=editor&long=true`.

The fixture mounts the real Layout, Editor and pending-change Review.
Compendium categories are synthetic sidebar-store entries; its content
is a placeholder, not a matching or guidance session. The sample and entry
routes render the real ReviewQueue against six synthetic entries, with in-memory
storage and network-blocked guidance. All data is in-memory, authentication is
absent, and no decision handlers are invoked. Do not edit, save, sign in or
trigger decisions.

Read the hidden `#result` output after loading. `PASS` includes actual
top/end rectangles, clientHeight, scrollHeight, scrollTop, final-link
bounds, Close bounds, selection and network requests. The sample and entry
fixtures also measure decision targets at real scroll positions, final
evidence/input reachability, the measured action-bar height, and the ends
of both picker and bulk-preview overlays. `workspace=review` filters to
`no-such-fixture-xyz`, measures Clear filters in the empty state, then
activates it and verifies the visible list is restored.

The assertions require one viewport-bounded Browse body, reachable final
links, stationary Close/background, no horizontal overflow, 44px Review
and decision targets, focused filter reset, focus containment/restoration
and unchanged selection after close/reopen. Failures are explicit and
the readiness wait is bounded to five seconds. The fixture leaves Browse
open at the top for a screenshot; scroll its body to the end for the
companion capture.

At **1440x1000**, repeat the queues for desktop density. Use
`workspace=editor` without `long=true` for the representative short
English tooltip, German Source-to-English fallback, sticky phone panel
tabs and desktop divider. The long shared-owner fixture deliberately
stresses sidebar sizing, not representative editor-header reachability.

The mounted navigation test checks structure and the stretch rule only.
It does not supply browser layout geometry. This fixture is the
permanent rendered regression; headless results do not imply physical
phone, IME or real-account clearance.

At each viewport, the sample and entry variants report action-bar and
decision-button rectangles, the last input/evidence rectangle, document
width, overlay end controls/evidence and blocked guidance requests. Phone
sample actions are checked from first reachability through the full document
end; picker and bulk overlays must stop above the actual measured decision
bar and keep their final evidence/controls reachable. No fixture decision is
submitted.
