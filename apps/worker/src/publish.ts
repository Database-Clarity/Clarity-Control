import { refuseBaseEnhanced } from './baseEnhanced.js';
import { refuseHeldSetBonuses } from './setBonusHold.js';
import { publisherPinPath, refuseUnlowerable } from './elementTags.js';
import { loadAliases } from './catalog.js';
import { pinMergesSandboxPointers, withSandboxPointers } from './sandboxPointers.js';
import { z } from 'zod';
import {
  classifyPublishIntent,
  isTextlessDescription,
  permissionsSchema,
  publishBodySchema,
  publishIntentDigest,
  publishMonth,
  publishableHash,
  resolveAlias,
  sandboxPointersPath,
  publishOpIdSchema,
  publishPayloadSchema,
  stableStringify,
  validatePublishTime,
  type Aliases,
} from '@clarity/core';
import { unbase64 } from './crypto.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import type { GitHub, RepoFile, TreeNode } from './github.js';
import { schedulePaths } from '@clarity/core/schedule';
import { switches } from './schedule/store.js';
import type { Env, Identity } from './types.js';

const envelopeSchema = z.object({ payload: z.string(), sig: z.string() }).strict();
const logSchema = z.object({ intentDigest: z.string().nullable(), result: z.unknown() });
const opPaths = (id: string) => [
  `publish/requests/${id}.json`,
  `publish/log/${publishMonth(id)}/${id}.json`,
];
const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

// One completed value per isolate, keyed by exact secret; no shared in-flight I/O.
let signingCache:
  | {
      secret: string;
      value: { key: CryptoKey; publicKey: string; fingerprint: string };
    }
  | undefined;
const statusIdsSchema = z.array(publishOpIdSchema).min(1).max(1);
const resultStatusSchema = z.object({
  status: z.enum(['done', 'unchanged', 'stale', 'rejected', 'failed', 'cancelled']),
});
const kickSchema = z.object({ opId: publishOpIdSchema }).strict();

/** PKCS8 PEM secret. Only the public SPKI and its fingerprint may leave this module. */
export async function signingKey(env: Env) {
  if (!env.PUBLISH_SIGNING_KEY) throw new HttpError(503, 'Publisher is not enabled');
  if (signingCache?.secret === env.PUBLISH_SIGNING_KEY) return signingCache.value;
  try {
    const der = unbase64(env.PUBLISH_SIGNING_KEY.replace(/-----[^-]+-----|\s/g, ''));
    const key = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'OKP',
        crv: 'Ed25519',
        x: jwk.x,
      },
      'Ed25519',
      true,
      ['verify'],
    );
    const spki = await crypto.subtle.exportKey('spki', publicKey);
    const pem = `-----BEGIN PUBLIC KEY-----\n${base64(spki)
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END PUBLIC KEY-----\n`;
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', spki))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const value = { key, publicKey: pem, fingerprint };
    signingCache = { secret: env.PUBLISH_SIGNING_KEY, value };
    return value;
  } catch {
    throw new HttpError(503, 'Publisher signing key unavailable');
  }
}
export async function publishKey(env: Env) {
  const { publicKey, fingerprint } = await signingKey(env);
  return json({ algorithm: 'Ed25519', publicKey, fingerprint });
}
function pending(file: RepoFile | null) {
  return file
    ? publishPayloadSchema.parse(JSON.parse(envelopeSchema.parse(file.value).payload))
    : undefined;
}
function logged(file: RepoFile | null) {
  return file ? logSchema.parse(file.value) : undefined;
}

/**
 * Admission copy of the publisher's guard (R3): a hash whose batch activation conflicted waits for
 * its resolution before any manual publish. The publisher enforces it again at drain time (I1).
 */
function refuseActivationConflicts(
  listing: readonly TreeNode[] | null | undefined,
  hashes: readonly number[],
  aliases: Aliases,
): void {
  if (!listing?.length) return;
  const names = new Set(listing.map(({ name }) => name));
  const blocked = hashes.filter((hash) => names.has(`${resolveAlias(hash, aliases)}.json`));
  if (blocked.length)
    throw new HttpError(
      409,
      `Tooltip ${blocked[0]} has an unresolved batch activation; resolve it first`,
      {
        hashes: blocked,
      },
    );
}

export async function publish(request: Request, github: GitHub, user: Identity) {
  const value = await body(request, publishBodySchema, 300 * 1024);
  const intent = {
    ...value,
    kind: 'push' as const,
    repo: `${github.env.GITHUB_OWNER}/${github.env.GITHUB_REPO}`,
    dataBranch: github.env.DATA_BRANCH,
    liveBranch: github.env.LIVE_BRANCH,
    requester: { id: user.id, login: user.login },
  };
  const digest = await publishIntentDigest(intent);
  const paths = opPaths(value.opId);
  let checkedHead: string | undefined;
  let generatorAliases: Awaited<ReturnType<typeof loadAliases>> | undefined;
  let aliases: Awaited<ReturnType<typeof loadAliases>> = {};
  // Two create attempts plus a final reconciliation. Without imports, at most 13 requests
  // including token, aliases, and native-markup checks; dependency reads use the shared budget.
  // a final read is mandatory even when the last create timed out after landing.
  for (let attempt = 0; attempt < 3; attempt++) {
    // The publisher's PIN rides in the same read: its build must lower element-tagged text.
    // While scheduled batches are enabled, a names-only listing of the activation conflicts joins
    // the same read (0 extra subrequests; spec "Activation and conflicts", R3).
    const snapshot = await github.publishSnapshot(
      ['config/permissions.json', ...paths, publisherPinPath, sandboxPointersPath],
      [],
      switches.scheduled() ? [{ path: schedulePaths.conflictsDir, depth: 1 }] : [],
    );
    requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, [
      'maintainer',
      'editor',
    ]);
    const existingLog = logged(snapshot.files[2]);
    // A tombstone wins even if a malformed stray request was injected later.
    const decision = classifyPublishIntent(
      digest,
      existingLog ? undefined : pending(snapshot.files[1]),
      existingLog ? { ...existingLog, intentDigest: existingLog.intentDigest ?? '' } : undefined,
    );
    if (decision.status === 'conflict')
      throw new HttpError(409, 'opId already names another publish intent');
    if (decision.status === 'complete') return json({ opId: value.opId, result: decision.result });
    if (decision.status === 'pending') return json({ opId: value.opId, status: 'pending' }, 202);
    if (attempt === 2) break;
    try {
      // body() already enforced the byte cap and full schema. Only the clock can change.
      validatePublishTime(value.opId, Date.now());
    } catch {
      throw new HttpError(400, 'Publish opId outside creation window');
    }
    if (checkedHead !== snapshot.head) {
      generatorAliases ??= await loadAliases(github.env, github);
      // Sandbox picks join the aliases only for a publisher build that merges them itself, so the
      // reviewed digests match what that build records (an older build: a mismatch refuses).
      const pin = snapshot.files[1 + paths.length]?.value;
      aliases = pinMergesSandboxPointers(pin)
        ? await withSandboxPointers(github, generatorAliases, snapshot.files[2 + paths.length])
        : generatorAliases;
      const checked = await refuseBaseEnhanced(github, snapshot.head, value.hashes, aliases);
      // A tagged span, `#{name}`, or `<enhanced/>` in a published tooltip or a document it reads
      // (imports, globals 2 and 3) needs a publisher build that lowers it; an older build would
      // export it unlowered.
      for (const document of checked.values())
        refuseUnlowerable(document, { value: pin }, 'published');
      refuseHeldSetBonuses(
        value.hashes.flatMap((hash) => checked.get(resolveAlias(hash, aliases)) ?? []),
      );
      refuseActivationConflicts(snapshot.trees[0], value.hashes, aliases);
      for (const hash of value.hashes) {
        const tooltip = checked.get(resolveAlias(hash, aliases));
        if (tooltip && isTextlessDescription(tooltip))
          throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
        if (!tooltip || (await publishableHash(tooltip, aliases)) !== value.expected[hash]) {
          throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
        }
      }
      checkedHead = snapshot.head;
    }
    const { key } = await signingKey(github.env);
    const payload = stableStringify({
      ...intent,
      createdAt: new Date().toISOString(),
      intentDigest: digest,
    });
    const sig = base64(await crypto.subtle.sign('Ed25519', key, encoder.encode(payload)));
    try {
      await github.createPublishRequest(
        snapshot.head,
        snapshot.tree,
        paths[0],
        { payload, sig },
        user,
      );
      return json({ opId: value.opId, status: 'pending' }, 202);
    } catch {
      // Every write failure is ambiguous. Re-read at the next head, never overwrite a request.
    }
  }
  throw new HttpError(503, 'Publish create unresolved; retry the same opId and body');
}

export async function publishStatus(request: Request, github: GitHub, user: Identity) {
  const url = new URL(request.url);
  const parsed = statusIdsSchema.safeParse(url.searchParams.getAll('opId'));
  if (!parsed.success || [...url.searchParams.keys()].some((k) => k !== 'opId'))
    throw new HttpError(400, 'Supply exactly one opId query parameter');
  const ids = parsed.data;
  // Terminal logs retain per-hash results. A single log per call bounds parse CPU;
  // pending request bodies are never fetched for status.
  const snapshot = await github.publishSnapshot(
    ['config/permissions.json', ...ids.flatMap(opPaths)],
    ids.map((id) => opPaths(id)[0]),
  );
  requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, ['maintainer', 'editor']);
  // Fixed projection: no signed requests, tooltips, digests, run errors or repository metadata.
  return json({
    operations: ids.map((opId, i) => {
      const log = logged(snapshot.files[2 + i * 2]);
      const result = resultStatusSchema.safeParse(log?.result);
      return {
        opId,
        status: log
          ? result.success
            ? result.data.status
            : 'failed'
          : snapshot.files[1 + i * 2]
            ? 'pending'
            : 'unknown',
      };
    }),
  });
}

export async function publishKick(request: Request, github: GitHub, user: Identity) {
  const { opId } = await body(request, kickSchema, 1024);
  const paths = opPaths(opId);
  const snapshot = await github.publishSnapshot(['config/permissions.json', ...paths], paths);
  requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, ['maintainer', 'editor']);
  if (snapshot.files[2] || !snapshot.files[1])
    throw new HttpError(409, 'Publish request is not pending');
  await signingKey(github.env); // Kicks remain disabled until the enable-time secret is installed.
  await github.kickPublish(opId);
  return json({ opId, status: 'pending' }, 202);
}
