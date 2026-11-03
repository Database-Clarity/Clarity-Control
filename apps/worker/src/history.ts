import { z } from 'zod';
import { legacyPublishableHash, publishableHash, pushedSchema, tooltipSchema } from '@clarity/core';
import type { GitHub } from './github.js';
import { catalog } from './catalog.js';
import { HttpError, json } from './http.js';

export const historySchema = z.array(
  z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    commit: z.object({
      author: z.object({ name: z.string(), date: z.string() }).nullable(),
      message: z.string(),
    }),
    author: z.object({ login: z.string(), avatar_url: z.string().url().optional() }).nullable(),
  }),
);

export async function pushedVersion(github: GitHub, hash: number, head: string): Promise<Response> {
  const pushed = pushedSchema.parse((await github.requiredFile('live/pushed.json', head)).value);
  const digest = pushed[hash];
  if (!digest) return json({ pushedHash: null, tooltip: null });
  const snapshot = await github.file(`live/tooltips/${hash}.json`, head);
  if (snapshot) {
    const tooltip = tooltipSchema.parse(snapshot.value);
    // The snapshot is committed together with its marker. The marker also covers the aliases at
    // push time, which cannot be recomputed after they change, so only the hash is checked.
    if (tooltip.hash === hash) return json({ pushedHash: digest, tooltip });
    throw new HttpError(502, 'Pushed tooltip snapshot does not match its marker');
  }
  // Older markers predate snapshots. Match content, not the marker commit's newer working text.
  // The marker may predate the fallback/alias inputs, or may not have covered aliases: try each.
  const { aliases } = await catalog(github.env);
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      sha: head,
      path: `tooltips/${hash}.json`,
      per_page: '30',
      page: String(page),
    });
    const commits = historySchema.parse(await github.result(`/commits?${query}`));
    for (const entry of commits) {
      const file = await github.file(`tooltips/${hash}.json`, entry.sha);
      if (!file) continue;
      const tooltip = tooltipSchema.parse(file.value);
      if (tooltip.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
      if (
        (await publishableHash(tooltip, aliases)) === digest ||
        (await publishableHash(tooltip)) === digest ||
        (await legacyPublishableHash(tooltip)) === digest
      ) {
        return json({ pushedHash: digest, tooltip });
      }
    }
    if (commits.length < 30) break;
  }
  throw new HttpError(
    409,
    'The pushed version could not be recovered from history. No live comparison is available; publish again to record a snapshot.',
  );
}
