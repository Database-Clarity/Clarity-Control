# Installing the export build (owner-gated)

Nothing here is installed by this repository. Each step is a production change to
`Database-Clarity/Live-Clarity-Database` that needs the owner's OK (spec section 12).

## Files and where they go

| Source in this repository                                                                             | Target branch | Target path                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| output of `node packages/export/build.mjs --install <dir> --generator-sha <sha>`                      | `converter`   | `.exports/` (engine.mjs, config.mjs, build-site.mjs, legacy-job.mjs, config.json, PIN) |
| `packages/export/workflows/converter/.github/workflows/build-outputs.yml`                             | `converter`   | `.github/workflows/build-outputs.yml`                                                  |
| `packages/export/workflows/converter/.github/workflows/main.yml`                                      | `converter`   | `.github/workflows/main.yml` (replaces today's)                                        |
| `packages/export/workflows/editor-data/.github/workflows/exports.yml`                                 | `editor-data` | `.github/workflows/exports.yml`                                                        |
| `scripts/publisher/template/.github/workflows/pipeline.yml` (now with `paths-ignore: ['exports/**']`) | `editor-data` | `.github/workflows/pipeline.yml`, at publisher enable step E                           |

- `.exports/` is built from a committed tree (the script refuses uncommitted changes in
  packages/export) and `PIN` names that source SHA; the script prints each file's sha256 for the
  install commit message. `config.json` holds the generator SHA used until the first publish receipt
  on `converter` names one (`--generator-sha`: the generator commit the publisher config pins).
- `.exports/` and `build-outputs.yml` go in one commit, before the new `main.yml` (which calls it).
  The push of `main.yml` itself starts the first run: the legacy job deploys `live` and writes the
  first pin; the site job then finds zero Pages deployments and bootstraps.
- `exports.yml` can follow at any time; before the first pin, a config save builds nothing.
- Until step E, today's `bundle.yml` also runs on every editor-data push; it needs the same
  `paths-ignore: ['exports/**']` if configs are written before step E.

## The publish pipeline's downstream job

Its `converter` push uses `github.token`, which starts no workflow, so once the pipeline writes to
`converter` (not `converter-v2-test`), it calls the build itself after a successful push. The
pipeline job must expose whether it pushed `converter`:

```yaml
jobs:
  # ...the existing pipeline job, plus:
  outputs:
    needs: pipeline
    if: needs.pipeline.outputs.converter-pushed == 'true'
    permissions:
      contents: write
    uses: Database-Clarity/Live-Clarity-Database/.github/workflows/build-outputs.yml@converter
    with:
      legacy: true
    secrets: inherit
```

## Behaviour that differs from today's main.yml

- The engine is pinned (`.exports/PIN`) instead of `npm i @icemourne/description-converter`.
- The deploy replaces only `descriptions/` and `versions.json` on `live`; README.md and
  `.github/` stay (today's clean deploy keeps README.md only, so it would delete the contributors
  workflow that now lives on `live`).
- `versions.json` is read from the `live` checkout, not raw.githubusercontent (stale in its cache).
- A failed or frozen file keeps its old bytes; a failed Bungie manifest fetch deploys nothing and
  writes no pin (the next publish retries); a run older than the last deploy deploys nothing.
- The deploy commit keeps today's subject and adds `Export-Converter:` and `Export-Pin:` lines.
