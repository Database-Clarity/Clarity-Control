import { refuseBaseEnhanced } from './baseEnhanced.js';
import { refuseHeldSetBonuses } from './setBonusHold.js';
import { publisherPinPath, refuseUnlowerable } from './elementTags.js';
import { loadAliases } from './catalog.js';
import {
  pinMergesSandboxPointers,
  consumerAliasScope,
  refuseUnsupportedAliasGroups,
  withSandboxPointers,
} from './sandboxPointers.js';
import { pinAppliesInactiveMoves, storedInactiveMoves } from './inactiveMoves.js';
import { z } from 'zod';
import {
  classifyPublishIntent,
  globalsInPlacePath,
  globalsInPlacePublishContract,
  aliasGroupsPath,
  isTextlessDescription,
  permissionsSchema,
  publishBodySchema,
  publishIntentDigest,
  publishMonth,
  inactivePublishableHash,
  inactiveRemovalHash,
  inactiveMovesPath,
  isMovedInactive,
  selectedInactiveMoves,
  resolveAlias,
  sandboxPointersPath,
  publishOpIdSchema,
  publishPayloadSchema,
  stableStringify,
  globalIdSchema,
  hashSchema,
  translationLanguageSchema,
  translationPublishBodySchema,
  translationPublishIntentDigest,
  translationPublishPayloadSchema,
  translationPublishReasons,
  validatePublishTime,
  type Aliases,
  type Tooltip,
  type TranslationPublishBody,
  type TranslationPublishPayload,
} from '@clarity/core';
import { unbase64 } from './crypto.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import type { GitHub, RepoFile, TreeNode } from './github.js';
import { scheduleIntentPaths, schedulePaths } from '@clarity/core/schedule';
import { switches } from './schedule/store.js';
import type { Env, Identity } from './types.js';
import { inPlaceAdmission } from './globals/inPlace.js';
import {
  requireTranslationLanguages,
  rowIdentity,
  translationPartRows,
  translationPublishEnabled,
  translationReadinessPaths,
  translationRoots,
  translationRowPaths,
  verifyTranslationRows,
  wantsTranslationContract,
} from './translationPublish.js';

const envelopeSchema = z.object({ payload: z.string(), sig: z.string() }).strict();
const logSchema = z.object({
  intentDigest: z.string().nullable(),
  request: z.unknown().optional(),
  result: z.unknown(),
});
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
      value: { key: CryptoKey; verificationKey: CryptoKey; publicKey: string; fingerprint: string };
    }
  | undefined;
const statusIdsSchema = z.array(publishOpIdSchema).min(1).max(1);
const resultStatusSchema = z.object({
  status: z.enum(['done', 'unchanged', 'stale', 'rejected', 'failed', 'cancelled']),
});
const kickSchema = z.object({ opId: publishOpIdSchema }).strict();
const scopedRowIdentity = { lang: translationLanguageSchema };
const safeResultRow = z
  .discriminatedUnion('kind', [
    z.object({ ...scopedRowIdentity, kind: z.literal('tooltip'), hash: hashSchema }),
    z.object({ ...scopedRowIdentity, kind: z.literal('global'), id: globalIdSchema }),
  ])
  .and(z.object({ reason: z.enum(Object.keys(translationPublishReasons)).optional() }));

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
    const value = { key, verificationKey: publicKey, publicKey: pem, fingerprint };
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
  if (!file) return undefined;
  const raw = JSON.parse(envelopeSchema.parse(file.value).payload);
  return raw?.scope === 'translations'
    ? translationPublishPayloadSchema.parse(raw)
    : publishPayloadSchema.parse(raw);
}
function logged(file: RepoFile | null) {
  return file ? logSchema.parse(file.value) : undefined;
}

function pendingTranslation(file: RepoFile | null) {
  if (!file) return undefined;
  try {
    const raw = JSON.parse(envelopeSchema.parse(file.value).payload);
    const payload = translationPublishPayloadSchema.safeParse(raw);
    if (payload.success) return payload.data;
  } catch {
    // An unreadable request still occupies its ID.
  }
  return { intentDigest: '' };
}

async function signRequest(env: Env, value: unknown) {
  const { key } = await signingKey(env);
  const payload = stableStringify(value);
  const sig = base64(await crypto.subtle.sign('Ed25519', key, encoder.encode(payload)));
  return { payload, sig };
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
  const raw = await body(request, z.unknown(), 300 * 1024);
  if (raw && typeof raw === 'object' && 'scope' in raw && raw.scope === 'translations') {
    if ('rows' in raw && Array.isArray(raw.rows) && raw.rows.length > translationPartRows)
      throw new HttpError(413, 'Reload Review changes to send this publish in smaller parts.', {
        partRows: translationPartRows,
      });
    const scoped = translationPublishBodySchema.safeParse(raw);
    if (!scoped.success) throw new HttpError(400, 'Invalid request', scoped.error.issues);
    return publishTranslations(request, github, user, scoped.data);
  }
  const parsed = publishBodySchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
  const value = parsed.data;
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
      [
        'config/permissions.json',
        ...paths,
        publisherPinPath,
        sandboxPointersPath,
        inactiveMovesPath,
        aliasGroupsPath,
        globalsInPlacePath,
      ],
      [],
      [
        ...(switches.scheduled() ? [{ path: schedulePaths.conflictsDir, depth: 1 as const }] : []),
        { path: 'globals', depth: 1 },
      ],
    );
    requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, [
      'maintainer',
      'editor',
    ]);
    if (
      snapshot.files.at(-1)?.value !== undefined &&
      new URL(request.url).searchParams.get('contract') !== globalsInPlacePublishContract
    )
      throw new HttpError(409, 'Reload this page before publishing shared text.');
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
      const pin = snapshot.files[1 + paths.length]?.value;
      const fence = inPlaceAdmission(
        snapshot.files.at(-1)?.value,
        pin,
        value.hashes,
        github.env.LIVE_BRANCH,
      );
      if (!fence && (value.globals || snapshot.trees[switches.scheduled() ? 1 : 0] != null))
        throw new HttpError(409, 'Complete the shared text migration before publishing.');
      if (fence) checkedHead = snapshot.head;
    }
    if (checkedHead !== snapshot.head) {
      // Sandbox picks join the aliases only for a publisher build that merges them itself, so the
      // reviewed digests match what that build records (an older build: a mismatch refuses).
      const pin = snapshot.files[1 + paths.length]?.value;
      const groups = snapshot.files[4 + paths.length];
      if (groups) refuseUnsupportedAliasGroups(groups, pin);
      if (!groups) generatorAliases ??= await loadAliases(github.env, github);
      const pointerFile = pinMergesSandboxPointers(pin) ? snapshot.files[2 + paths.length] : null;
      const scope = groups
        ? await consumerAliasScope(github, groups, pointerFile, value.hashes)
        : undefined;
      aliases =
        scope?.aliases ??
        (pinMergesSandboxPointers(pin)
          ? await withSandboxPointers(github, generatorAliases ?? {}, pointerFile)
          : (generatorAliases ?? {}));
      const moves = storedInactiveMoves(snapshot.files[3 + paths.length]);
      if (
        Object.keys(
          selectedInactiveMoves(
            moves,
            value.hashes.map((hash) => resolveAlias(hash, aliases)),
            aliases,
          ),
        ).length &&
        !pinAppliesInactiveMoves(pin)
      )
        throw new HttpError(
          409,
          'The installed publisher lacks the "inactiveMoves" capability; update it before publishing these rows',
        );
      const active = value.hashes.filter(
        (hash) => !isMovedInactive(resolveAlias(hash, aliases), moves),
      );
      const checked = active.length
        ? await refuseBaseEnhanced(github, snapshot.head, active, aliases, [], scope)
        : new Map<number, Tooltip>();
      aliases = scope?.aliases ?? aliases;
      // A tagged span, `#{name}`, or `<enhanced/>` in a published tooltip or a document it reads
      // (imports, globals 2 and 3) needs a publisher build that lowers it; an older build would
      // export it unlowered.
      for (const document of checked.values())
        refuseUnlowerable(document, { value: pin }, 'published');
      refuseHeldSetBonuses(
        active.flatMap((hash) => checked.get(resolveAlias(hash, aliases)) ?? []),
      );
      if (switches.scheduled()) refuseActivationConflicts(snapshot.trees[0], value.hashes, aliases);
      for (const hash of value.hashes) {
        if (isMovedInactive(resolveAlias(hash, aliases), moves)) {
          if ((await inactiveRemovalHash(resolveAlias(hash, aliases))) !== value.expected[hash])
            throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
          continue;
        }
        const tooltip = checked.get(resolveAlias(hash, aliases));
        if (tooltip && isTextlessDescription(tooltip))
          throw new HttpError(422, `Tooltip ${hash} has no text to publish`);
        if (
          !tooltip ||
          (await inactivePublishableHash(tooltip, aliases, moves)) !== value.expected[hash]
        ) {
          throw new HttpError(409, `Tooltip ${hash} changed since review; refresh saved changes`);
        }
      }
      checkedHead = snapshot.head;
    }
    const envelope = await signRequest(github.env, {
      ...intent,
      createdAt: new Date().toISOString(),
      intentDigest: digest,
    });
    try {
      await github.createPublishRequest(snapshot.head, snapshot.tree, paths[0], envelope, user);
      return json({ opId: value.opId, status: 'pending' }, 202);
    } catch {
      // Every write failure is ambiguous. Re-read at the next head, never overwrite a request.
    }
  }
  throw new HttpError(503, 'Publish create unresolved; retry the same opId and body');
}

async function publishTranslations(
  request: Request,
  github: GitHub,
  user: Identity,
  value: TranslationPublishBody,
) {
  if (!wantsTranslationContract(new URL(request.url)))
    throw new HttpError(409, 'Reload Review changes before publishing translations.');
  const { opId, rows } = value;
  const [requestPath, logPath] = opPaths(opId);
  const reservationPath = scheduleIntentPaths.request(opId);
  const { env } = github;
  const rowPaths = translationRowPaths(rows, env.LIVE_BRANCH);
  const intent = {
    ...value,
    kind: 'push' as const,
    repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    dataBranch: env.DATA_BRANCH,
    liveBranch: env.LIVE_BRANCH,
    requester: { id: user.id, login: user.login },
  };
  const digest = await translationPublishIntentDigest(intent);
  const admissionPaths = ['config/permissions.json', requestPath, logPath, reservationPath];
  // One write attempt per invocation. After an ambiguous write, reconcile at a fresh
  // head without rereading reviewed sources. A new HTTP attempt revalidates before it writes.
  for (const creating of [true, false]) {
    const snapshot = await github.publishSnapshot(
      creating ? [...admissionPaths, ...translationReadinessPaths, ...rowPaths] : admissionPaths,
      [reservationPath],
      creating ? [{ path: schedulePaths.conflictsDir, depth: 1 }] : [],
    );
    const [permissions, queued, logFile, reservation, ...sources] = snapshot.files;
    const access = requireAccess(permissionsSchema.parse(permissions?.value), user, ['translator']);
    requireTranslationLanguages(access, rows);
    const log = logged(logFile);
    const decision = classifyPublishIntent(
      digest,
      log ? undefined : pendingTranslation(queued),
      log ? { ...log, intentDigest: log.intentDigest ?? '' } : undefined,
    );
    if (decision.status === 'conflict')
      throw new HttpError(409, 'opId already names another publish intent');
    if (decision.status === 'complete')
      return json({ opId, result: safeTranslationResult(log?.result, value) });
    if (decision.status === 'pending') return json({ opId, status: 'pending' }, 202);
    // Schedule preparation reserves the publication ID before its signed request exists.
    if (reservation) throw new HttpError(409, 'opId already names another publish intent');
    if (!creating) break;
    if (!translationPublishEnabled(env))
      throw new HttpError(503, 'Translation publishing is not enabled.');
    const roots = translationRoots(sources, env.LIVE_BRANCH);
    if (!roots)
      throw new HttpError(409, 'This destination is not ready for translation publishing.');
    try {
      validatePublishTime(opId, Date.now());
    } catch {
      throw new HttpError(400, 'Publish opId outside creation window');
    }
    const files = new Map(
      rowPaths.map((path, i) => [path, sources[i + translationReadinessPaths.length] ?? null]),
    );
    await verifyTranslationRows(rows, env.LIVE_BRANCH, files, roots, snapshot.trees[0]);
    const envelope = await signRequest(env, {
      ...intent,
      createdAt: new Date().toISOString(),
      intentDigest: digest,
    });
    try {
      await github.createPublishRequest(snapshot.head, snapshot.tree, requestPath, envelope, user);
      return json({ opId, status: 'pending' }, 202);
    } catch {
      // Reconcile the existing request or log before asking the client to retry.
    }
  }
  throw new HttpError(503, 'Publish create unresolved; retry the same opId and body');
}

async function verifiedTranslationPayload(
  raw: unknown,
  opId: string,
  env: Env,
): Promise<TranslationPublishPayload | undefined> {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return undefined;
  try {
    const { payload, sig } = envelope.data;
    const parsed = translationPublishPayloadSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    if (
      value.opId !== opId ||
      value.repo !== `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` ||
      value.dataBranch !== env.DATA_BRANCH ||
      value.liveBranch !== env.LIVE_BRANCH
    )
      return undefined;
    const { verificationKey } = await signingKey(env);
    if (
      await crypto.subtle.verify('Ed25519', verificationKey, unbase64(sig), encoder.encode(payload))
    )
      return value;
  } catch {
    // A log can legitimately carry a rejected, unverifiable envelope. It has no scoped owner.
  }
  return undefined;
}

function safeTranslationResult(raw: unknown, request: TranslationPublishBody) {
  const result = resultStatusSchema.safeParse(raw);
  const rawRows = (raw as { rows?: unknown } | null)?.rows;
  const rowKey = ({ kind, lang, ...row }: ReturnType<typeof rowIdentity>) =>
    `${kind}/${'hash' in row ? row.hash : row.id}/${lang}`;
  const selected = new Set(request.rows.map((row) => rowKey(rowIdentity(row))));
  const rows = [];
  if (Array.isArray(rawRows)) {
    for (const rawRow of rawRows.slice(0, request.rows.length)) {
      const parsed = safeResultRow.safeParse(rawRow);
      if (!parsed.success) continue;
      const { reason, ...row } = parsed.data;
      if (reason && selected.delete(rowKey(row))) rows.push({ ...row, reason });
    }
  }
  return { status: result.success ? result.data.status : ('failed' as const), rows };
}

export async function publishStatus(request: Request, github: GitHub, user: Identity) {
  const url = new URL(request.url);
  const scoped = wantsTranslationContract(url);
  const parsed = statusIdsSchema.safeParse(url.searchParams.getAll('opId'));
  if (
    !parsed.success ||
    [...url.searchParams.keys()].some((k) => k !== 'opId' && !(scoped && k === 'contract'))
  )
    throw new HttpError(400, 'Supply exactly one opId query parameter');
  const ids = parsed.data;
  // Terminal logs retain per-hash results. A single log per call bounds parse CPU;
  // pending request bodies are never fetched for status.
  const snapshot = await github.publishSnapshot(
    ['config/permissions.json', ...ids.flatMap(opPaths)],
    ids.map((id) => opPaths(id)[0]),
  );
  const access = requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, [
    'maintainer',
    'editor',
    ...(scoped ? ['translator' as const] : []),
  ]);
  if (scoped) {
    const [opId] = ids;
    const logFile = snapshot.files[2];
    const log = logSchema.safeParse(logFile?.value).data;
    const translator = access.role === 'translator';
    // Editors and maintainers can already see every status. Read a pending envelope only
    // when verifying a translator's ownership, at the same pinned DATA head as permissions.
    const [queued] =
      translator && !logFile && snapshot.files[1]
        ? await github.blobs([{ ref: snapshot.head, path: opPaths(opId)[0] }])
        : [];
    const owner = await verifiedTranslationPayload(
      logFile ? log?.request : queued?.value,
      opId,
      github.env,
    );
    if (
      translator &&
      (!owner ||
        owner.requester.id !== user.id ||
        (logFile && owner.intentDigest !== log?.intentDigest))
    )
      return json({ operations: [{ opId, status: 'unknown' }] });
    if (log && owner && owner.intentDigest === log.intentDigest)
      return json({ operations: [{ opId, ...safeTranslationResult(log.result, owner) }] });
  }
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
  const access = requireAccess(permissionsSchema.parse(snapshot.files[0]?.value), user, [
    'maintainer',
    'editor',
    'translator',
  ]);
  if (access.role === 'translator') {
    const terminal = !!snapshot.files[2];
    const [file] =
      terminal || snapshot.files[1]
        ? await github.blobs([{ ref: snapshot.head, path: paths[terminal ? 1 : 0] }])
        : [];
    const log = terminal ? logSchema.safeParse(file?.value).data : undefined;
    const owner = await verifiedTranslationPayload(
      terminal ? log?.request : file?.value,
      opId,
      github.env,
    );
    if (
      !owner ||
      owner.requester.id !== user.id ||
      (terminal && owner.intentDigest !== log?.intentDigest)
    )
      throw new HttpError(403, 'Permission denied');
    if (!terminal) requireTranslationLanguages(access, owner.rows);
  }
  if (snapshot.files[2] || !snapshot.files[1])
    throw new HttpError(409, 'Publish request is not pending');
  await signingKey(github.env); // Kicks remain disabled until the enable-time secret is installed.
  await github.kickPublish(opId);
  return json({ opId, status: 'pending' }, 202);
}
