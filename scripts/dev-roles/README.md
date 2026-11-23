# Local role testing

Run `npm run dev:roles` from the repository root with Node.js 24, Git, and the
workspace dependencies installed. Use the printed loopback URL. Each launch
fetches the current editor data, generator outputs, and Compendium bundle
anonymously. The printed revisions and bare Git directory identify the inputs
and the worktree-local copy. The copy remains under `.agents/dev-roles/` for
inspection. D1 starts empty and applies the repository migrations
for settings, worklists, snippets, reports, and attachments.

Open **Dev role**, choose an identity, and select **Switch**. The app reloads
the current route with a per-tab session. Use a fresh browser context when
reusing a port for independent checks. The choice lives on the app origin and
expires after eight hours or when a new local server starts.

| Identity            | Query value                                                        |
| ------------------- | ------------------------------------------------------------------ |
| Maintainer          | `maintainer`                                                       |
| Editor              | `editor`                                                           |
| Trial editor        | `trial`                                                            |
| Translator          | `translator-de` (replace `de` with a supported non-English locale) |
| Translation manager | `manager-de` (same locale rule)                                    |
| Export partner      | `partner`                                                          |

For headless tests, navigate to
`http://127.0.0.1:5187/?dev-role=translator-de#/translations`, then wait for the
signed-in identity. The query is removed when the choice succeeds. To test a
signed-out flow, open a fresh context with no role query. The actual Worker
reads synthetic account permissions seeded into the copied
`config/permissions.json`. A partner receives access to the configured local
projects, if present.

## Local integrations

- The real Worker routes handle tooltip saves, schedule edits, globals, marks,
  settings, worklists, snippets, and reports. The local runner dispatches the
  scheduled triggers. The local publishing run writes receipts and consumer
  changes to `converter-v2-test` in the disposable Git store.
- The loopback host issues short-lived sessions. The Worker verifies them
  using an ephemeral signing key. GitHub account lookups use copied permissions
  and synthetic test accounts.
- Reports use local D1, the copied report catalogs, and a synthetic Turnstile
  challenge. Compendium refresh simulates a completed run with the copied
  bundle. Hosted Actions, converter CDN output, report catalog regeneration,
  and spreadsheet imports require the hosted integrations.

## Worked Playwright flow

Run `npm run test:dev-roles:browser` from the repository root. The script starts
its own fresh instance and uses an installed Chromium browser. Set
`PICKER_BROWSER` to the browser executable if it is outside the standard
locations. Pass a tooltip hash after `--` to select another published tooltip.
The real publisher prepares the starting proofs, refreshes them after the save,
and applies the publish request. Allow 20–30 minutes on a Windows checkout.

The script adds or edits German, saves from the editor, checks the resulting data
commit, and verifies that English is read-only and a forced save returns
HTTP 403. It switches to editor, publishes the same tooltip, waits for the
published state, and verifies the disposable live ref advanced. If Review
requires a pending dependency, the script includes the requested row.
