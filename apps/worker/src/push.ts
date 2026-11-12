import { refuseBaseEnhanced } from './baseEnhanced.js';
import { refuseHeldSetBonuses } from './setBonusHold.js';
import { refuseTaggedEntries } from './elementTags.js';
import { z } from 'zod';
import {
  publishableHash,
  isTextlessDescription,
  exportLegacy,
  hashSchema,
  pushedSchema,
  tooltipSchema,
  resolveAlias,
  sandboxPointersPath,
  type Aliases,
  type LegacyCatalog,
  type Permissions,
  type Tooltip,
} from '@clarity/core';
import { catalog } from './catalog.js';
import { blobsPerQuery, RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import { stampUploads } from './stamp.js';
import { withSandboxPointers } from './sandboxPointers.js';
import type { Identity } from './types.js';

/**
 * Not a product limit: a request this large is far past every tooltip there is. The Worker reads
 * the tooltips in batches (see GitHub.blobs), so the number of GitHub calls barely grows with the
 * selection; this only keeps one request inside the 48-subrequest budget (see below) and body.
 */
const maxHashes = 10_000;
const pushSchema = z
  .object({
    hashes: z
      .array(hashSchema)
      .min(1)
      .max(maxHashes)
      .refine((hashes) => new Set(hashes).size === hashes.length, 'Duplicate tooltip hash'),
    expected: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  })
  .strict();
const liveSchema = z
  .object({
    perks: z.record(z.string(), z.unknown()),
    databaseSettings: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const roles: Permissions['users'][string]['role'][] = ['maintainer', 'editor'];

/**
 * Subrequests (Workers FREE plan: 50 per request; GitHub.subrequestLimit keeps two spare):
 *   token 1 + catalog 3 (once) +
 *   write live, per attempt: head 1, permissions 1*, tooltip batches ceil((n+1)/500)* (the +1 is
 *     config/sandbox-pointers.json, read in the same batch), generator sandbox conflicts 1* only
 *     when a pick points at a tooltip, globals 1*, marker 1*,
 *     live head 1, live file 2 (contents + blob, it is over 1 MB), PUT 1 = 8 + batches
 *   record, per attempt: head 1, permissions 1, live head 1, marker 1, commit 4 = 8
 * (* skipped when the data head did not move since the previous attempt). The total for a
 * first-try push without imports is 20 + batches, i.e. 26 for all ~2500 tooltips.
 * Import graph reads also spend from the same fail-closed budget. A
 * retry that no longer fits stops before touching GitHub, so a push can never run the
 * platform out of subrequests halfway through (the dangerous point is after the live write).
 */
const writeLiveCost = (batches: number) => 9 + batches;
const recordCost = 8;

interface Loaded {
  head: string;
  /** Generator aliases plus the sandbox picks at `head`: what this push's stubs and digests use. */
  aliases: Aliases;
  config: Permissions;
  tooltips: Tooltip[];
  snapshots: Record<string, Tooltip>;
  exportedHashes: Record<string, string>;
  pushed: Record<string, string>;
}

async function loadAtHead(
  github: GitHub,
  head: string,
  config: Permissions,
  canonicalHashes: number[],
  aliases: Aliases,
  facts: LegacyCatalog,
  expected: Record<string, string> | undefined,
): Promise<Loaded> {
  const files = await github.files(
    [...canonicalHashes.map((hash) => `tooltips/${hash}.json`), sandboxPointersPath],
    head,
  );
  // Sandbox picks join the generator aliases before any digest or stub (core mergeSandboxPointers).
  aliases = await withSandboxPointers(github, aliases, files[canonicalHashes.length]);
  const tooltips: Tooltip[] = [];
  const snapshots: Record<string, Tooltip> = {};
  const exportedHashes: Record<string, string> = {};
  for (const [index, hash] of canonicalHashes.entries()) {
    const file = files[index];
    if (!file) throw new HttpError(404, `Tooltip ${hash} does not exist`);
    const tooltip = tooltipSchema.parse(file.value);
    if (tooltip.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
    if (isTextlessDescription(tooltip))
      throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
    tooltips.push(tooltip);
    snapshots[`live/tooltips/${hash}.json`] = tooltip;
    exportedHashes[hash] = await publishableHash(tooltip, aliases);
    if (expected && expected[hash] !== exportedHashes[hash]) {
      throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
    }
  }
  for (const tooltip of tooltips) {
    if (!facts[tooltip.hash] && !tooltip.custom) {
      throw new HttpError(422, `Missing generator facts for tooltip ${tooltip.hash}`);
    }
  }
  refuseHeldSetBonuses(tooltips, facts);
  // Element-tagged text needs no hold here: exportLegacy lowers it to today's format, and the
  // export itself is checked below (refuseTaggedEntries) before anything is written.
  await refuseBaseEnhanced(github, head, canonicalHashes, aliases, tooltips);
  // A malformed marker is reported by the marker step below; here it just means "all changed".
  const pushed =
    pushedSchema.safeParse((await github.requiredFile('live/pushed.json', head)).value).data ?? {};
  return { head, aliases, config, tooltips, snapshots, exportedHashes, pushed };
}

export async function pushLive(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const { hashes, expected } = await body(request, pushSchema);
  let liveCommit: string | undefined;
  let loaded: Loaded | undefined;
  let facts: LegacyCatalog | undefined;
  let aliases: Aliases | undefined;
  let canonicalHashes: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      github.remaining <
      writeLiveCost(Math.ceil((hashes.length + 1) / blobsPerQuery)) + recordCost
    ) {
      if (!attempt) {
        throw new HttpError(503, 'This push needs too many upstream requests; push fewer tooltips');
      }
      break;
    }
    const head = await github.head();
    // Permissions are re-checked every attempt. Files at one commit never change, so when the
    // data head has not moved the already-read copy is the current one.
    const config = loaded?.head === head ? loaded.config : await permissions(github, head);
    requireAccess(config, user, roles);
    if (!facts || !aliases) {
      const generated = await catalog(github.env, github);
      facts = generated.facts;
      aliases = generated.aliases;
      canonicalHashes = [...new Set(hashes.map((hash) => resolveAlias(hash, generated.aliases)))];
    }
    if (loaded?.head !== head) {
      loaded = await loadAtHead(github, head, config, canonicalHashes, aliases, facts, expected);
    }
    const { tooltips, exportedHashes, pushed } = loaded;
    const changed = new Set(
      canonicalHashes.filter((hash) => pushed[hash] !== exportedHashes[hash]),
    );
    // Dependency traversal has a variable cost. Re-check the reservation after its
    // actual reads, before any live I/O, so a successful PUT always leaves recordCost.
    if (github.remaining < 4 + recordCost) {
      if (!attempt)
        throw new HttpError(503, 'This push needs too many upstream requests; push fewer tooltips');
      break;
    }
    const liveHead = await github.head(github.env.LIVE_BRANCH);
    const file = await github.requiredFile('liveDescriptions.json', liveHead);
    const live = liveSchema.parse(file.value);
    const now = Date.now();
    const entries = exportLegacy(tooltips, now, facts, loaded.aliases);
    refuseTaggedEntries(entries);
    stampUploads(entries, changed, live.perks, now, user.login);
    try {
      liveCommit = await github.putLive(
        file.sha,
        {
          ...live,
          perks: { ...live.perks, ...entries },
        },
        user,
      );
      break;
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  if (!liveCommit || !loaded) throw new HttpError(409, 'Live branch kept moving; retry push-live');
  const { exportedHashes, snapshots } = loaded;

  // The two branches cannot be committed atomically. Never mark a newer save as pushed.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (github.remaining < recordCost) break;
      const head = await github.head();
      requireAccess(await permissions(github, head), user, roles);
      if ((await github.head(github.env.LIVE_BRANCH)) !== liveCommit) {
        throw new HttpError(409, 'Live changed before recording push; retry push-live');
      }
      const pushed = pushedSchema.parse(
        (await github.requiredFile('live/pushed.json', head)).value,
      );
      try {
        const commit = await github.commit(
          head,
          {
            'live/pushed.json': { ...pushed, ...exportedHashes },
            ...snapshots,
          },
          `Record push to ${github.env.LIVE_BRANCH} at ${liveCommit}`,
          user,
        );
        return json({ commit, liveCommit, pushed: exportedHashes, branch: github.env.LIVE_BRANCH });
      } catch (error) {
        if (!(error instanceof RefRace)) throw error;
      }
    }
    throw new HttpError(409, 'Data branch kept moving; retry push-live to record its status');
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(error.status, error.message, { liveCommit, pushedRecorded: false });
    }
    console.error(
      'Push marker failed after live write',
      error instanceof Error ? error.message : 'Unknown error',
    );
    throw new HttpError(502, 'Live was written, but recording the push failed; retry push-live', {
      liveCommit,
      pushedRecorded: false,
    });
  }
}
