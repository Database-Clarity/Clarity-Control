import { z } from 'zod';
import {
  publishableHash,
  exportLegacy,
  hashSchema,
  pushedSchema,
  tooltipSchema,
  resolveAlias,
  type Tooltip,
} from '@clarity/core';
import { catalog } from './catalog.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import { stampUploads } from './stamp.js';
import type { Identity } from './types.js';

const pushSchema = z
  .object({
    hashes: z
      .array(hashSchema)
      .min(1)
      .max(100)
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

export async function pushLive(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const { hashes, expected } = await body(request, pushSchema);
  let liveCommit: string | undefined;
  let exportedHashes: Record<string, string> = {};
  let snapshots: Record<string, Tooltip> = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    exportedHashes = {};
    snapshots = {};
    const head = await github.head();
    requireAccess(await permissions(github, head), user, ['maintainer', 'editor']);
    const { facts, aliases, weaponTypeLabels } = await catalog(github.env);
    const canonicalHashes = [...new Set(hashes.map((hash) => resolveAlias(hash, aliases)))];
    const tooltips: Tooltip[] = [];
    for (const hash of canonicalHashes) {
      const file = await github.file(`tooltips/${hash}.json`, head);
      if (!file) throw new HttpError(404, `Tooltip ${hash} does not exist`);
      const tooltip = tooltipSchema.parse(file.value);
      if (tooltip.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
      tooltips.push(tooltip);
      snapshots[`live/tooltips/${hash}.json`] = tooltip;
      exportedHashes[hash] = await publishableHash(tooltip);
      if (expected && expected[hash] !== exportedHashes[hash]) {
        throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
      }
    }
    for (const tooltip of tooltips) {
      if (!facts[tooltip.hash] && !tooltip.custom) {
        throw new HttpError(422, `Missing generator facts for tooltip ${tooltip.hash}`);
      }
    }
    // A malformed marker is reported by the marker step below; here it just means "all changed".
    const pushed =
      pushedSchema.safeParse((await github.requiredFile('live/pushed.json', head)).value).data ?? {};
    const changed = new Set(
      canonicalHashes.filter((hash) => pushed[hash] !== exportedHashes[hash]),
    );
    const liveHead = await github.head(github.env.LIVE_BRANCH);
    const file = await github.requiredFile('liveDescriptions.json', liveHead);
    const live = liveSchema.parse(file.value);
    const now = Date.now();
    const entries = exportLegacy(tooltips, now, facts, aliases);
    stampUploads(entries, changed, live.perks, now, user.login);
    try {
      liveCommit = await github.putLive(
        file.sha,
        {
          ...live,
          // Every other setting stays exactly as live has it.
          databaseSettings: { ...live.databaseSettings, weaponTypeLabels },
          perks: { ...live.perks, ...entries },
        },
        user,
      );
      break;
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  if (!liveCommit) throw new HttpError(409, 'Live branch kept moving; retry push-live');

  // The two branches cannot be committed atomically. Never mark a newer save as pushed.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await github.head();
      requireAccess(await permissions(github, head), user, ['maintainer', 'editor']);
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
