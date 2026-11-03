import {
  classifyPublishIntent,
  permissionsSchema,
  publishIntentDigest,
  stableStringify,
  validatePublishBody,
  type PublishPayload,
  type PublishIntent,
} from '../../packages/core/src/index.js';
import type { Repository, Tree } from './git.js';
import { paths } from './publisher.js';

/** Local Git/API simulator for the Worker's head-bound create algorithm; no HTTP or remote writes. */
export async function createRequest(
  git: Repository,
  intent: PublishIntent,
  now: () => number,
  sign: (payload: string) => string,
) {
  const ref = `refs/heads/${intent.dataBranch}`,
    p = paths(intent.opId),
    digest = await publishIntentDigest(intent);
  const read = <T>(t: Tree, path: string) =>
    t[path] ? (JSON.parse(git.blob(t[path])) as T) : undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const h = git.head(ref)!;
    const tree = git.tree(h);
    const permissions = permissionsSchema.parse(read(tree, 'config/permissions.json'));
    if (!['maintainer', 'editor'].includes(permissions.users[String(intent.requester.id)]?.role))
      throw new Error('Permission denied');
    const envelope = read<{ payload: string }>(tree, p.request);
    const existing = envelope ? (JSON.parse(envelope.payload) as PublishPayload) : undefined;
    const log = read<{ intentDigest: string; result: unknown }>(tree, p.log);
    const decision = classifyPublishIntent(digest, existing, log);
    if (decision.status !== 'create') return decision;
    if (attempt === 3) throw new Error('Create unresolved; retry SAME opId');
    validatePublishBody(
      { opId: intent.opId, hashes: intent.hashes, expected: intent.expected },
      now(),
    );
    const payload = stableStringify({
      ...intent,
      createdAt: new Date(now()).toISOString(),
      intentDigest: digest,
    });
    tree[p.request] = git.writeBlob(JSON.stringify({ payload, sig: sign(payload) }));
    const c = git.commit(h, tree, `Request ${intent.opId}`);
    try {
      git.cas(ref, h, c);
      return { status: 'pending' as const };
    } catch {
      /* every error rereads one fresh head */
    }
  }
  throw new Error('Unreachable');
}
