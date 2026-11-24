# Installing the export build (owner-gated)

Nothing here is installed by this repository. Each step is a production change to
`Database-Clarity/Live-Clarity-Database` that needs the owner's OK (spec section 12).

## Files and where they go

| Source in this repository                                                                                 | Target branch | Target path                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| output of `node packages/export/build.mjs --install <dir> --generator-sha <sha>`                          | `converter`   | `.exports/` (engine.mjs, config.mjs, build-site.mjs, legacy-job.mjs, config.json, PIN) |
| `scripts/publisher/template/.github/workflows/build-outputs.yml`                                          | `converter`   | `.github/workflows/build-outputs.yml`                                                  |
| `packages/export/workflows/converter/.github/workflows/main.yml`                                          | `converter`   | `.github/workflows/main.yml` (replaces today's)                                        |
| `packages/export/workflows/editor-data/.github/workflows/exports.yml`                                     | `editor-data` | `.github/workflows/exports.yml`                                                        |
| explicit output of `scripts/publisher/install.mjs` (`--target=test` or owner-gated `--target=production`) | `editor-data` | `.github/workflows/pipeline.yml` and `.github/workflows/publisher-run.yml`, at publisher enable step E |

- `.exports/` is built from a committed tree (the script refuses uncommitted changes in
  packages/export) and `PIN` names that source SHA; the script prints each file's sha256 for the
  install commit message. `config.json` holds the generator SHA used until the first publish receipt
  on `converter` names one (`--generator-sha`: the generator commit the publisher config pins).
- `build-outputs.yml` has ONE canonical source: the S2 publisher template above. Do not
  restore an older workflow during an engine-only or kept-language install. The engine build
  script writes only `.exports/`; it never installs workflows. Workflow adoption follows the
  separately approved G5 drain, hosted dry validation, and installation order in
  `scripts/publisher/E2-RUNBOOK.md`. For an initial bootstrap, install the approved engine
  and canonical reusable workflow before enabling `main.yml` (which calls it).
  The push of `main.yml` itself starts the first run: the legacy job deploys `live` and writes the
  first pin; the site job then finds zero Pages deployments and bootstraps.
- `exports.yml` can follow at any time; before the first pin, a config save builds nothing.
- Until step E, today's `bundle.yml` also runs on every editor-data push; it needs the same
  `paths-ignore: ['exports/**']` if configs are written before step E.

## After installing

- The first runs from `converter` (main.yml) and `editor-data` (exports.yml and the production
  pipeline caller) must reach the deploy step with the token (environment `data-site-deploy`,
  deployment branches `converter` and `editor-data`), and a run from any other ref must be
  refused by the environment. This could not
  be run before the install (it needs the workflows in the repository).

## Kept-language rollout precondition

Deploy the kept-language feature in this order (root ruling, 2026-11-17):

1. Install `.exports/` built from `02e745048a233b99c700a34eec75670bcdfbd222`
   or a descendant containing kept-language support.
2. Run the legacy publishing job successfully and verify that the effective publish pin names
   that installed engine and its converter commit. A failed manifest fetch does not advance the
   pin, so an installation alone does not satisfy this step.
3. Deploy the Worker containing the kept-language save and confirmation routes.

An older pin's strict config schema rejects kept-language entries (`reason: "language"` and
active/retained subsets sharing a folder). If the Worker saves one before the pin advances,
build-site marks that project invalid and carries all of its previous URLs without updating
them until a compatible pin is effective. The compatibility fallback for older pins preserves
their protected entries; it does not teach their schema the new config shape. Installs, pin
advances, and Worker deployment remain owner-gated.

## Format v2 rollout

Install the format v2 export engine, then run the legacy publishing job and verify that the
effective pin names the new engine before enabling v2 saves in the Worker and web app.
While the effective pin still names an older engine, the new build-site script leaves the
served site in place. Old preview snapshots can still open legacy files while waiting for
a v2 data build.

Before republishing, check the current editor-data export configs for any configurable
v1 URLs that partners use. Keep any such URL updating for three months before deletion.
The built-in reference moves to `/reference/v2/`. Verify the seven legacy files and
`clarityV2` byte for byte against the previous engine with the same input and manifest.

## The publish pipeline's downstream job

The explicit production installer plan appends `scripts/publisher/template/production-job.yml`,
which passes the immutable receipt/input/engine/generator identity. The test plan includes no
production call. Use that canonical job rather than reconstructing a legacy:boolean-only caller.
Install and rollback ordering, FIFO limits, and G8 recovery are in the publisher runbook.

## Behaviour that differs from today's main.yml

- The engine is pinned (`.exports/PIN`) instead of `npm i @icemourne/description-converter`.
- The deploy replaces only `descriptions/` and `versions.json` on `live`; README.md and
  `.github/` stay (today's clean deploy keeps README.md only, so it would delete the contributors
  workflow that now lives on `live`).
- `versions.json` is read from the `live` checkout, not raw.githubusercontent (stale in its cache).
- A failed or frozen file keeps its old bytes; a failed Bungie manifest fetch deploys nothing and
  writes no pin (the next publish retries); a run older than the last deploy deploys nothing.
- The deploy commit keeps today's subject and adds `Export-Converter:` and `Export-Pin:` lines.

## Arrow symbol rollout precondition

Before installing an `arrowSymbol` publisher PIN in editor-data, install the
`.exports/` converter engine built from source commit
`83da713384bb0c399209e43851e32fca5e035ca1` or a descendant that includes its arrow
lowering. Verify that its `buildLegacy` emits U+1F81A for `<arrow/>` in all seven
old-URL files, and record the installed `.exports/PIN`.

This engine installation is also required before enabling publisher writes to
the production `converter` branch. The publisher preserves `<arrow/>` in the
shared `liveDescriptions.json` intermediate; its `arrowSymbol` capability alone
does not update or verify the downstream converter. An older engine or the held
npm converter drops the arrow. Keep the Worker's PIN gate closed until both
components are installed. Installs and cut-over remain owner-gated.
