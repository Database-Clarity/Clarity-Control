# Provenance

The legacy part of this package (`src/converter/`) is a copy of the held description converter.

## Source

- Repository: `Database-Clarity/Description-converter`
- Branch: `agents/converter-refval`
- Commit: `047673916754f2b4a9af2635612dac8876af0dd7` (package `@icemourne/description-converter`
  1.0.56). It contains the held merge `6b4fa9137e28e326a913b5b707bc773cf1c2bedc` (GitHub compare
  `6b4fa91...0476739`: ahead 2, behind 0; the two extra commits are "Reject invalid publisher
  references before output" and "fix: make named export resolution prototype-safe").
- Retrieved 2026-11-11 as the GitHub tarball of that commit.
- License: MIT, author Icemourne. The repository has no LICENSE file; its `package.json` declares
  `"license": "MIT"`. `LICENSE` here is the MIT text with the copyright line of the same author's
  `@icemourne/tool-box` 1.0.43 LICENSE, which also covers the two tool-box functions copied into
  `src/converter/helpers.ts`.

## What was copied

| Source | Here |
|---|---|
| `src/*.ts`, `src/converterFunctions/*.ts` (except `doMath.ts`) | `src/converter/` (same names) |
| `index.ts` | `src/converter/index.ts` (import paths only) |
| `examples/publisher.ts`, `databaseConverter` | `src/converter/publisher.ts` |
| `examples/publisher.ts`, command-line part | `src/legacy.ts` (`buildLegacy`, `buildAllLegacy`, `nextVersions`) |
| `@icemourne/tool-box` 1.0.43 `cleanObject`, `customJsonStringify` | `src/converter/helpers.ts` |

Not copied: the tests (they used `node:test` against the built package), `examples/externalData.ts`
(it fetched the Bungie manifest; callers now pass the result, see `bungieIdentical`), the npm
publish workflow, and the README.

## Every change from the source

1. lodash removed. `_.pick` became `pick` in `helpers.ts` (same key order: the order asked for;
   same `key in object` test). In `publisher.ts`, `_.transform` became a `for … of
   Object.entries` loop and `_.omit(cleanPerk, 'editor')` an object rest.
2. tool-box removed. `cleanObject` and `customJsonStringify` are copied into `helpers.ts`;
   inside `cleanObject`, `_.pull` became an in-place removal (holes count as `undefined`, as in
   lodash), `_.isNil` a nullish test, and `_.isEmpty` a length/size/own-key test.
3. Safe math. `doMath.ts` ran the regex-selected `${…}` expression as JavaScript. It is replaced
   by `converterFunctions/math.ts`, which calls core's `evaluateMarkupMath` (numbers and + - * /
   only, normal precedence, same 2-decimal rounding). Census of every string the held converter
   passed to `doMath` while building all 8 presets: input (i) 41,684 calls, input (ii) 43,196
   calls, 297 distinct `${…}` expressions each, 0 differences. The two forms where they differ
   are pinned in `test/engine.test.ts` and appear in no data: `${5--3}` (JavaScript: syntax
   error, which failed the whole held release; here 8) and leading zeros such as `${010}`
   (JavaScript's old octal 8; here 10).
4. Bungie-identical rows. The held publisher compared each row's English text with the
   manifest inside `databaseConverter`. Here the caller passes the list of such hashes
   (`identical`); `bungieIdentical` computes it with the same test.
5. Command line. The held CLI built all presets before writing any file and fetched
   `versions.json` itself; one failure stopped the release. `buildAllLegacy` builds each file
   on its own and takes the previous `versions.json` value from the caller.
6. Lint only (no runtime change): `\/` became `/` inside one template string
   (`lineConverter.ts`); two `!` after optional chains removed (`descriptionConverter.ts`);
   `String` became `string` in a type (`livePerkTypes.ts`); two `eslint-disable-next-line`
   comments (`descriptionFilter.ts`). Line endings normalised to LF.

## Byte parity (G-PARITY)

`test/fixtures/legacy-sha256.json` holds the sha256 of each file the held converter (built from
its own lockfile) wrote for three inputs; the `parity-*.test.ts` tests fail on any byte change.

- (i) Live-Clarity-Database `converter-v2-test` `0bd5daebe80c1efcbad21d86658ec5d70e4f0da5`
  `liveDescriptions.json` (the same bytes as `packages/core/test/fixtures/live.json`).
- (ii) editor-data `52007db2344f92232f8c14e479d32ae405cc5863` through core `exportLegacy` with the
  generator catalog at `c3fed8cbdebc1a810d2ce1527d12c3f3530535e2` (2,528 tooltips, 2,599 alias
  stubs), committed gzipped.
- (iii) `test/fixtures/legacy-input.json`: every symbol, title, link, weapon section, alias kind,
  set bonus, element tag, math use, nested import, and global.

Bungie-identical lists for (i) and (ii) come from manifest `245114.26.10.13.2000-1-bnet.66137`
(`test/fixtures/legacy-identical.json`). With that manifest, the 7 deployed files for input (i)
are also byte-identical to Live-Clarity-Database `live` `039cfbc4732c33573568b28cc6335dd3332a9296`,
the deploy built from `0bd5dae`.
