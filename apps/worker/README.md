# Clarity editor API

Cloudflare Worker for GitHub App sign-in, permission-checked editing and publishing.
There is no database: authored data lives on a Git branch, and sessions are signed
30-day bearer tokens. Follow [OWNER-SETUP.md](./OWNER-SETUP.md) before deployment.
This package does not deploy as part of the root build.

## Endpoints

All errors are JSON `{ error, details? }`. Send `Authorization: Bearer <session>`
except for OAuth and Compendium requests. CORS allows `SITE_ORIGIN` and
`http://localhost:5173`; other browser origins are rejected, including on writes.
Roles always come from `config/permissions.json` on the current data-branch head,
never from a request or token. Permissions are read on every request and retry
(no stale permission cache).

| Method / path                             | Request                                                                  | Success                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `GET /auth/login`                         | Browser navigation                                                       | 302 to GitHub; signed, browser-bound OAuth state cookie (10 minutes)   |
| `GET /auth/callback`                      | GitHub `code`, `state` query                                             | 302 to `SITE_URL#/auth/callback?session=<token>`; state cookie cleared |
| `GET /me`                                 | Bearer token                                                             | `{ id: number, login, role: string \| null, languages: string[] }`     |
| `POST /save`                              | `{ changes: [{ hash, base: Tooltip \| null, next: Tooltip }], message }` | `{ commit, tooltips: Tooltip[] }`                                      |
| `POST /push-live`                         | `{ hashes: number[] }`                                                   | `{ commit, liveCommit, pushed: { [hash]: publishableHash }, branch }`  |
| `POST /compendium/refresh`                | Editor/maintainer token                                                  | 202 `{ requestedAt, runId }`                                           |
| `GET /compendium/refresh/status`          | Editor/maintainer token                                                  | `{ run: { id, status, conclusion, created_at, html_url } \| null }`    |
| `GET /permissions`                        | Maintainer token                                                         | `{ revision, permissions: { users: { [githubId]: { login, role, languages? } } } }` |
| `PUT /permissions`                        | `{ revision, permissions }`; maintainer only. 409 if `revision` is stale | `{ commit, revision, permissions }`                                    |
| `GET /history/:hash?page=1`               | Authorized member token                                                  | `{ page, commits: [{ commit, author, date, message }] }`, 30 per page  |
| `GET /history/:hash?commit=<40-char SHA>` | Authorized member token                                                  | `{ commit, tooltip }`                                                  |
| `GET /history/:hash?live=1`               | Authorized member token                                                  | `{ pushedHash: string \| null, tooltip: Tooltip \| null }`             |
| `GET /settings`                           | Authorized member token                                                  | `{ settings: SyncedSettings \| null, revision, unreadable }`           |
| `PUT /settings`                           | `{ settings, revision: string \| null }`, at most 4096 bytes             | `{ settings, revision }`; 409 `{ error, settings, revision }`          |

History entries additionally include `login` and `avatar` (nullable); `author`
retains the git-name fallback. Push-live accepts an optional `expected` map of
reviewed publishable digests and rejects changed selections with 409 before writing.
It records each exported tooltip in `live/tooltips/<hash>.json` atomically with
its pushed marker. The live-history query validates this snapshot against its marker.
For older markers it searches up to 300 historical versions for matching publishable
content; missing history is an explicit 409, never a guessed baseline. No marker
returns nulls. The snapshot represents authored text before export-time fallbacks.

The web app must consume the session from the callback **fragment**, remove it
from browser history immediately, and use it in the bearer header. It must not
send the token in URLs or logs. OAuth user access tokens are used only to fetch
GitHub identity and are not persisted. A signed-in, unconfigured user gets
`role: null` and cannot read history or write. All data commits name the editor
as author (`login`, `<id>+<login>@users.noreply.github.com`) and the App bot as
committer. The installation token is restricted to the configured repository.

### Synced user settings

`/settings` never touches the data branch. It writes `settings.json` on a separate
branch (`SETTINGS_BRANCH`, default `editor-settings`; created as a root commit on the
first sync): `{ v: 1, entries: { <HMAC-SHA256(id key, user id)>: { iv, ct } } }`.
Every entry is AES-256-GCM under one server-wide key, with the entry id as associated
data and the plaintext padded to a fixed 512-byte bucket. Both keys are derived with
HKDF-SHA256 from `SESSION_SECRET` (salt and info `clarity-user-settings-v1/...`). Each
sync re-encrypts every entry with fresh nonces in one commit, so a commit does not show
whose settings changed. Settings commits use the bot as author and committer, the
fixed message `Update synced settings`, and a date rounded down to the UTC hour.
`revision` is a random id inside the ciphertext, so other users' syncs never cause
conflicts. A PUT with a stale revision gets 409 and the stored copy. Identical
settings are not rewritten. A ref race retries up to three times. Unreadable entries
are reported to their owner as `unreadable` and dropped on the next re-encryption.
Rotating `SESSION_SECRET` signs everyone out and makes every entry unreadable;
clients keep their browser copy and re-upload on the next sync.

### Save and conflicts

Maximum 100 distinct changes per save; message length 1–500; JSON body <=2 MB.
`base: null` creates a tooltip only if its path does not exist. Hashes must agree
with their record and filenames. Deletion is not exposed.
Saving an alias hash returns 422 naming its canonical tooltip; old drafts cannot
recreate folded frame or sandbox tooltip files. Alias loading failures block
saves rather than bypassing that guard.

Maintainers, editors and trial users can edit. Translators can change only
`text[lang]` in their configured languages, not associations, snapshots, custom
fields or legacy metadata. Both the client delta and final merged delta are
checked. Core `merge3` merges concurrent language/field edits. A real conflict
returns **409** `{ conflicts: [{ hash, base, head, next, fields: string[] }] }`
without committing any of the changes. A create/delete race uses field
`"$exists"`. Resolve against `head` and resubmit it as `base`. A ref-update race
restarts permissions, reads and merging up to three times. Exhaustion returns
409 `{ error }`; clients must distinguish this from a field-conflict response.

### Push-live safety

Only editors and maintainers may push. `LIVE_BRANCH` defaults to
**`converter-v2-test`**, not production `converter`. The target branch must already
contain a copy of `liveDescriptions.json`. No endpoint creates branches.

Selected tooltips are read from one immutable data commit; generator `v2`
items/categories supply the core export catalog, including optional item facts.
Categories without a legacy type (verbs) retain their category id. Generic
`aliases.json` resolves requested frame/sandbox aliases to canonical tooltips and
deduplicates selections. Core export writes the shared text once, on the canonical
entry; every frame/sandbox alias is written as a reference stub
`{ hash, aliasOf, aliasKind, ...ownFacts }` (see `@clarity/core` `exportLegacy`), where
frame aliases keep their own manifest identity/category and sandbox aliases only the
facts the catalog has for them. Stubs are written as-is and never stamped.
**Cut-over constraint:** the converter that understands stubs must be published before
push-live targets the real `converter` branch; an older converter has no editor text on
stubs and would drop frame aliases. Pushed markers refer
only to canonical authored tooltips. Existing
unselected perks, database settings and other root fields are preserved.
Each request accepts 1–100 distinct selected hashes before canonical deduplication;
an alias selection exports its entire canonical group, so the output can exceed
100 entries. When sending `expected`, key digests by resolved canonical hash,
including for alias-only selections. Run rollout batches sequentially and inspect
each result before continuing. Unselected legacy alias copies remain intentionally
stale until their group is selected; this is different from a reference stub whose
canonical target is missing.
The target Contents API PUT checks the file SHA and retries collisions up to
three times. Then a separate Git Data commit updates `live/pushed.json` with the
**exported snapshot's** core `publishableHash` values, never a later editor save's
hashes. These hash only language text strings, associations and optional custom
identity, excluding edit/upload metadata and snapshots. Save still uses full
`contentHash` values for concurrency comparisons.

Upload stamping follows the legacy editor. Each attempt reads `live/pushed.json` at the
data head and the live file fresh. A selected tooltip whose `publishableHash` differs
from its pushed marker (or has none) is *changed*: its canonical entry gets
`lastUpload` = one timestamp for the whole push and `uploadedBy` = the pushing user's
GitHub login. An *unchanged* tooltip keeps `lastUpload`/`uploadedBy` from the current
live entry for that hash; with no live entry the exported
(migrated) values are left. Stored tooltip files are never stamped. A malformed marker
file counts as "all changed" for stamping and is reported by the marker step.

GitHub has no atomic transaction across two branches. If the live write succeeds
but the marker cannot be recorded, an explicit error includes
`details: { liveCommit, pushedRecorded: false }`. Retry push-live to reconcile.
A competing target-branch update detected before marking also returns that
partial-push error. Avoid simultaneous push-live operations; ordinary concurrent
saves are supported. Do not equate any failed push with “nothing was written.”
If a save changed after review, retrying the old `expected` digest returns 409
without another live write: review the saved version before retrying. A retry
exports again rather than only repairing markers, so a still-pending canonical
receives the retry's time/user stamp. Earlier batches and unrelated entries are
retained. During partial failure, pushed history still describes the last recorded
snapshot, not necessarily the latest live write.
`pushed.json` has no branch namespace: use a scratch data branch/repo when testing
publishing, and rerun migration/refresh markers when cutting over to production.

Compendium parsing runs in a daily/manual Action in the separate public
`Database-Clarity/Compendium-data` repository, not in the CPU-limited Worker.
The web app reads its `main/compendium.json` directly. Refresh/status require
current editor/maintainer access in the authored database; trial users and
translators cannot dispatch. An active refresh is reused instead of queued again.
`COMPENDIUM_OWNER` defaults to `GITHUB_OWNER`, `COMPENDIUM_REPO` to
`Compendium-data`, `COMPENDIUM_REF` to `main`, and `COMPENDIUM_WORKFLOW` to
`compendium.yml`. The same organization installation must cover both repositories,
with Actions read/write granted. Data writes still request Contents-only tokens;
refresh uses a separate token restricted to the Compendium repository and
Actions read/write (read-only for status). No bearer token reaches the client.
Content-identical runs do not advance `fetchedAt`; the UI also polls run
completion and can report an unchanged successful refresh.

## Development and verification

From the repository root, install with `npm ci`. Copy
[.dev.vars.example](./.dev.vars.example) to `.dev.vars` in this directory and fill
in a separately installed test App, a scratch repository and scratch branches.
Use real GitHub OAuth locally; there is **no authentication bypass**. Add the
local callback `http://localhost:8787/auth/callback` to the test App.

```powershell
npm run dev --workspace @clarity/worker
# Browser sign-in: http://localhost:8787/auth/login
# Web app: VITE_API_URL=http://localhost:8787 (web origin http://localhost:5173)

npm run typecheck
npm run lint
npm test
npx vitest run apps/worker/test
Set-Location apps\worker
npx wrangler deploy --dry-run
```

Tests generate a temporary in-memory RSA key and mock GitHub/Google fetches. They
cover the permission matrix, signed sessions and OAuth state, CORS, merge/409
atomicity, ref and file-SHA races, permission revocation during retries, actual
author/committer payloads, catalog projection/aliases, partial publishing,
history, and multiline CSV/cache expiry. They do not require secrets, an account,
or a network connection. A dry run bundles only; it does not deploy.
`push-batches.test.ts` and `push-recovery.test.ts` exercise the real Worker and
GitHub adapter against mocked services, including both rollout orders, 100/101
selections, group closure, partial failures and reviewed recovery. These offline
fixtures do not establish arbitrary batch ordering safety, real publisher adoption,
or an atomic transaction between the two branches.

Modules are organized by endpoint; `github.ts` owns installation authentication
and Git operations, `permissions.ts` owns access checks. Core owns tooltip and
permission schemas, content hashing, merging and legacy export. Upstream failures
return an explicit non-success response; unexpected failures are logged without
request tokens or private keys.

Wrangler is pinned to 4.153.0. The v2 workspace and CI use Node 24 LTS (see root
`.nvmrc`). Root `build` builds the web app and dry-run bundles the Worker; it
never deploys the Worker.
