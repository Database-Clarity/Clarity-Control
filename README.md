# Clarity description editor v2

This branch is the foundation for the new Clarity editor. The app currently lets you
navigate between placeholder screens; it does **not** load, edit, or publish live data.
The production editor remains unchanged on `main`.

## Get started

1. Install Node.js 24 LTS (Node 24 is used in CI; `.nvmrc` selects it).
2. Open a terminal in this repository's top-level folder.
3. Run `npm ci` to install all workspace dependencies.
4. Run `npm run dev -- --port 5173 --strictPort`.
5. Open http://localhost:5173/ in your browser.

Stop the server with Ctrl+C. Changes to the web source appear automatically.
If port 5173 is busy, stop your own old server or choose a different port.

## Where things live

| Folder/file                       | Purpose                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/`                       | React browser app; see its README for a source-code map.                                                                                                   |
| `apps/web/src/features/`          | Editor, navigation, review, Compendium, globals, and other feature folders.                                                                                |
| `apps/web/src/ui/`                | Shared UI components and styles.                                                                                                                           |
| `apps/web/src/services/`          | Future data access, kept separate from components.                                                                                                         |
| `packages/*`                      | Shared packages, including the separately developed pure TypeScript `core` package.                                                                        |
| `apps/worker/`                    | Cloudflare authentication and GitHub writes; see its [README](./apps/worker/README.md) and [owner setup](./apps/worker/OWNER-SETUP.md). Root build only dry-run bundles it, never deploys. |
| `legacy/`                         | Untouched old app, kept as **read-only reference** while porting. Not a workspace; excluded from lint, tests, formatting, and builds. Deleted at cut-over. |
| `tsconfig.json`                   | Shared strict TypeScript settings; workspace configs extend these.                                                                                         |
| `eslint.config.js`                | Shared lint rules, including React hooks and no explicit `any`.                                                                                            |
| `.github/workflows/v2-checks.yml` | Checks for pushes and pull requests targeting `v2`. The old deployment workflow is unchanged.                                                              |

Run commands from the repository root: npm workspaces installs dependencies together,
so you do not need to install each app separately. Workspaces cover `apps/*` and
`packages/*`, never `legacy/`. The preserved legacy manifest and lockfile describe the
old dependencies; do not install or develop there.

## Everyday commands

| Command             | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev`       | Starts the web development server.                                                        |
| `npm run typecheck` | Checks TypeScript in every workspace that provides a typecheck script.                    |
| `npm run lint`      | Checks active code for common mistakes.                                                   |
| `npm test`          | Runs Vitest tests across apps and packages; succeeds if no tests exist yet.               |
| `npm run build`     | Builds every workspace that provides a build script; web output goes to `apps/web/dist/`. |
| `npm run format`    | Formats active source and documentation with Prettier; skips legacy.                      |

Review branches (`review/**`) run the full suite silently in the Review suite workflow. The run stays green even when a check fails; read the `REVIEW-SUITE RESULT: PASS/FAIL` line in its job summary or log for the actual result and failing test names. Locally, `python -I D:\GitHub\Description-editor\.agents\t3\suite-lock\ci_suite.py <branch> [<sha>]` waits for that exact revision and exits 0 for PASS, 1 for FAIL, or 2 for an unavailable run or infrastructure problem.

To check your work, run typecheck, lint, test, and build before opening a pull request.
All four also run in CI after `npm ci`. New workspaces should expose `typecheck` and
`build` scripts as needed; name tests `*.test.ts`, `*.spec.ts`, or their TSX equivalents.

## Navigation

The app uses hash URLs so refreshing a link works on static hosting:

- `#/t/123`: tooltip editor (any tooltip hash).
- `#/review`: changes waiting for review.
- `#/compendium`: Compendium tracking.
- `#/drift`: in-game description changes.
- `#/translations`: translation status.
- `#/globals`: shared variables and titles.
- `#/globals/variables/example`: one global and, later, its usage links.
- `#/admin`: administration.

The left navigation uses normal router links, so browser back/forward works.
SCSS modules, original theme colors, and the DestinySymbols font keep the familiar
dark-and-orange look. No connection to production services is made by this shell.


Armor set bonuses use the generator's `armor-set-bonus` category and sandbox perk hash as
the tooltip identity. Finder entries show the set and piece count in 2pc/4pc order; retained
set-conversion selector records are hidden from finder and worklists. Compendium links match
Armor Perks cards by set name and explicit piece count and preserve that count when refreshed.
The existing Worker save permissions and hash-keyed export apply to these tooltips unchanged.

