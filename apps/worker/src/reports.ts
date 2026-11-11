import { z } from 'zod';
import {
  langSchema,
  reportSubmissionSchema,
  reportActionSchema,
  stableStringify,
  publishableHash,
  tooltipSchema,
  aliasesSchema,
  pushedSchema,
  type ReportSubmission,
} from '@clarity/core';
import { historySchema } from './history.js';
import { reportImage, reportImageBody } from './reportsFiles.js';
import { identity, siteOrigins } from './auth.js';
import { GitHub } from './github.js';
import { body as jsonBody, hashParam, HttpError, json } from './http.js';
import { permissions, type Access } from './permissions.js';
import type { Env, Identity } from './types.js';

/** Narrow structural binding contract; no dependency on global Workers DOM types. */
export interface ReportStatement {
  bind(...values: (string | number | null | ArrayBuffer | number[])[]): ReportStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: { rows_read?: number } }>;
  run(): Promise<{ meta: { changes: number; size_after?: number } }>;
}
export interface ReportsDatabase {
  prepare(sql: string): ReportStatement;
  batch(statements: ReportStatement[]): Promise<
    {
      results: Record<string, string | number>[];
      meta: { changes: number; size_after?: number; rows_read?: number };
    }[]
  >;
  exec(sql: string): Promise<unknown>;
}
export interface ReportRow {
  id: string;
  owner_hash: number;
  viewed_hash: number;
  variant: string;
  lang: string;
  status: string;
  version: number;
  reporter_id: number | null;
  request_id: string;
  payload_hash: string;
  withdraw_hash: string | null;
  created_at: number;
  updated_at: number;
  fix_publishable: string | null;
  published_at: number | null;
}
const now = () => Math.floor(Date.now() / 1000);
async function body<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
  const input = await jsonBody(request, z.unknown(), maxBytes);
  // These small, infrequent requests favour bounded cold parsing over eval/JIT
  // compilation. This is local to reports and does not change save validation.
  const parsed = schema.safeParse(input, { jitless: true });
  if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
  return parsed.data;
}
function reportLang(value: string | null) {
  const parsed = langSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid report language');
  return parsed.data;
}
export async function reportDigest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
export function reportDB(env: Env): ReportsDatabase {
  if (!env.REPORTS_DB) throw new HttpError(503, 'Reports are unavailable');
  return env.REPORTS_DB;
}
export const sql = (db: ReportsDatabase, text: string, ...values: (string | number | null)[]) =>
  db.prepare(text).bind(...values);
export async function reportRow(db: ReportsDatabase, id: string): Promise<ReportRow> {
  const row = await sql(db, 'SELECT * FROM reports WHERE id=?', id).first<ReportRow>();
  if (!row) throw new HttpError(404, 'Report not found');
  return row;
}
export function reportAccess(access: Access | undefined, lang?: string): void {
  if (
    !access ||
    (lang && access.role === 'translator' && !access.languages?.some((l) => l === lang))
  )
    throw new HttpError(403, 'Permission denied');
}
export function reportMaintainer(access: Access | undefined): void {
  if (access?.role !== 'maintainer') throw new HttpError(403, 'Maintainer role required');
}
const catalogItemSchema = z.object({
  owner: z.number().int().min(0).max(0xffffffff),
  langs: z.array(langSchema).max(13),
  variant: z.string().regex(/^(base|enhanced|override:\d+)$/),
});
const catalogSchema = z.object({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  // Validate the selected entry at use. Copying and validating every item on a
  // cold public POST would put catalogue growth on the request's CPU budget.
  items: z.custom<Record<string, unknown>>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  ),
});
let catalogCache: { key: string; until: number; data: z.infer<typeof catalogSchema> } | undefined;
let reportPermissionsCache:
  { key: string; until: number; users: Record<string, Access> } | undefined;
async function catalog(env: Env) {
  const key = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  if (catalogCache?.key === key && catalogCache.until > Date.now()) return catalogCache.data;
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${key}/editor-data-bundle/report-items.worker.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) throw new Error('Catalog unavailable');
    const data = catalogSchema.parse(await response.json(), { jitless: true });
    catalogCache = { key, data, until: Date.now() + 300_000 };
    return data;
  } catch {
    if (catalogCache?.key === key) return catalogCache.data;
    throw new HttpError(503, 'Reports are unavailable');
  }
}

/** Canonicalises equivalent IPv6 spellings through the URL parser before /64 masking. */
export function reportIP(ip: string): string {
  if (!ip.includes(':')) return ip;
  let host: string;
  try {
    host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    throw new HttpError(400, 'Invalid client address');
  }
  const [left, right] = host.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const words =
    right !== undefined ? [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b] : a;
  return words
    .slice(0, 4)
    .map((s) => Number.parseInt(s, 16).toString(16))
    .join(':');
}
type Limit = { key: string; cap: number; expires: number };
async function admission(
  request: Request,
  env: Env,
  db: ReportsDatabase,
  user: Identity | undefined,
  access: Access | undefined,
): Promise<{ limits: Limit[]; attempt: Limit }> {
  const time = now(),
    day = Math.floor(time / 86400),
    expires = (day + 1) * 86400;
  const settings = await db
    .prepare("SELECT key,value FROM meta WHERE key IN ('pause_all','pause_anonymous')")
    .all<{ key: string; value: string }>();
  if (settings.results.some((r) => r.value === '1' && (r.key === 'pause_all' || !user)))
    throw new HttpError(503, 'Reports are paused');
  if (
    user &&
    (await sql(db, 'SELECT reporter_id FROM blocked WHERE reporter_id=?', user.id).first())
  )
    throw new HttpError(403, 'Reporting is blocked');
  // A single salt row is replaced daily. Concurrent isolates read back the winning salt.
  await sql(
    db,
    "INSERT INTO meta(key,value) VALUES('daily_salt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE substr(meta.value,1,instr(meta.value,':')-1) <> ?",
    `${day}:${crypto.randomUUID()}`,
    String(day),
  ).run();
  const salt = await db
    .prepare("SELECT value FROM meta WHERE key='daily_salt'")
    .first<{ value: string }>();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt!.value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) throw new HttpError(503, 'Client address unavailable');
  const hmac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(reportIP(ip)));
  const hashed = Array.from(new Uint8Array(hmac), (b) => b.toString(16).padStart(2, '0')).join('');
  const limits = [
    {
      key: `ip10m:${hashed}:${Math.floor(time / 600)}`,
      cap: 3,
      expires: (Math.floor(time / 600) + 1) * 600,
    },
    { key: `ipday:${hashed}:${day}`, cap: 20, expires },
  ];
  if (user) limits.push({ key: `acc:${user.id}:${day}`, cap: 20, expires });
  if (!access) limits.push({ key: `global:${day}`, cap: 500, expires });
  const attempt = {
    key: `attempt10m:${hashed}:${Math.floor(time / 600)}`,
    cap: 10,
    expires: (Math.floor(time / 600) + 1) * 600,
  };
  await checkLimits(db, access ? limits : [...limits, attempt]);
  return { limits, attempt };
}
async function checkLimits(db: ReportsDatabase, limits: Limit[]) {
  const rows = await sql(
    db,
    `SELECT key,count,cap FROM limits WHERE key IN (${limits.map(() => '?').join(',')})`,
    ...limits.map((l) => l.key),
  ).all<{ key: string; count: number; cap: number }>();
  const full = limits.find((l) => rows.results.some((r) => r.key === l.key && r.count >= r.cap));
  if (full)
    throw new HttpError(
      full.key.startsWith('global:') ? 503 : 429,
      full.key.startsWith('global:') ? 'Reports are paused' : 'Report limit reached',
      { key: full.key.split(':')[0], retry_after: Math.max(1, full.expires - now()) },
    );
}
function limitStatements(db: ReportsDatabase, limits: Limit[]) {
  return limits.map((l) =>
    sql(
      db,
      'INSERT INTO limits(key,count,cap,expires_at) VALUES(?,1,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
      l.key,
      l.cap,
      l.expires,
    ),
  );
}
async function turnstile(env: Env, token: string | undefined) {
  if (!env.TURNSTILE_SECRET || !token) throw new HttpError(400, 'Human check required');
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    const data = z
      .object({
        success: z.boolean(),
        hostname: z.string().optional(),
        action: z.string().optional(),
      })
      .parse(await response.json());
    const hosts = siteOrigins(env).map((s) => new URL(s).hostname);
    if (env.REPORTS_ALLOW_LOCALHOST === 'true') hosts.push('localhost');
    if (
      !response.ok ||
      !data.success ||
      data.action !== 'report' ||
      !hosts.includes(data.hostname ?? '')
    )
      throw new Error('Failed check');
  } catch {
    throw new HttpError(400, 'Human check failed; retry');
  }
}
async function submit(
  request: Request,
  env: Env,
  db: ReportsDatabase,
  user: Identity | undefined,
  resolveAccess: () => Promise<Access | undefined>,
) {
  const input = await body(request, reportSubmissionSchema, 8192);
  const { turnstile: token, ...payload } = input;
  const payloadHash = await reportDigest(
    stableStringify({ ...payload, reporter_id: user?.id ?? null }),
  );
  const retry = async () => {
    const old = await sql(
      db,
      'SELECT id,status,payload_hash FROM reports WHERE request_id=?',
      input.request_id,
    ).first<{ id: string; status: string; payload_hash: string }>();
    if (!old) return null;
    if (old.payload_hash !== payloadHash)
      throw new HttpError(409, 'Request id belongs to a different report');
    return json({ id: old.id, status: old.status });
  };
  const existing = await retry();
  if (existing) return existing;
  const access = await resolveAccess();
  const { limits, attempt } = await admission(request, env, db, user, access);
  const items = await catalog(env);
  const selected = catalogItemSchema.safeParse(items.items[input.viewed_hash], { jitless: true });
  if (!selected.success) throw new HttpError(422, 'Unknown tooltip');
  const item = selected.data;
  const lang = item.langs.includes(input.lang)
    ? input.lang
    : item.langs.includes('en')
      ? 'en'
      : null;
  if (!lang) throw new HttpError(422, 'Tooltip has no reportable text');
  if (!access) {
    // Reserve a human-check attempt before the external call. Failed checks
    // and races cannot repeatedly consume siteverify without spending a limit.
    try {
      await db.batch(limitStatements(db, [attempt]));
    } catch (error) {
      if (String(error).includes('CHECK constraint'))
        throw new HttpError(429, 'Human check limit reached', {
          key: 'attempt10m',
          retry_after: Math.max(1, attempt.expires - now()),
        });
      throw new HttpError(503, 'Reports are unavailable');
    }
    await turnstile(env, token);
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const id =
    'r-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b & 31]).join('');
  const time = now();
  const statements = [
    ...limitStatements(db, limits),
    sql(
      db,
      `INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,seen_lang,rev,data_commit,category,note,source_url,src,reporter_id,reporter_login,trust,withdraw_hash,request_id,payload_hash,created_at,updated_at,links) VALUES(${Array(21).fill('?').join(',')})`,
      id,
      item.owner,
      input.viewed_hash,
      item.variant,
      lang,
      input.seen_lang ?? (lang !== input.lang ? input.lang : null),
      input.rev,
      input.data_commit,
      input.category,
      input.note,
      input.source_url ?? null,
      input.src ?? null,
      user?.id ?? null,
      user?.login ?? null,
      access ? 'role' : user ? 'account' : 'anonymous',
      await reportDigest(input.withdraw_secret),
      input.request_id,
      payloadHash,
      time,
      time,
      JSON.stringify(input.links),
    ),
    ...input.notes.map((n, index) => noteStatement(db, id, index + 1, n)),
    sql(
      db,
      "INSERT INTO events(report_id,at,actor_id,actor_login,action,to_status) VALUES(?,?,?,?,'submit','open')",
      id,
      time,
      user?.id ?? null,
      user?.login ?? null,
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await retry();
    if (raced) return raced;
    if (String(error).includes('CHECK constraint')) await checkLimits(db, limits);
    throw new HttpError(503, 'Reports are unavailable');
  }
  return json({ id, status: 'open' }, 201);
}
function noteStatement(
  db: ReportsDatabase,
  id: string,
  n: number,
  note: ReportSubmission['notes'][number],
) {
  const a = note.anchor;
  return sql(
    db,
    'INSERT INTO notes(report_id,n,category,text,exact,prefix,suffix,start,end,line,whole,rev) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id,
    n,
    note.category,
    note.text,
    a?.exact ?? null,
    a?.prefix ?? null,
    a?.suffix ?? null,
    a?.start ?? null,
    a?.end ?? null,
    a?.line ?? null,
    a ? 0 : 1,
    a?.rev ?? null,
  );
}
export async function reportOwn(
  row: ReportRow,
  user: Identity | undefined,
  secret: string | undefined,
) {
  if (user && user.id === row.reporter_id) return true;
  if (!row.reporter_id && secret && row.withdraw_hash) {
    const digest = await reportDigest(secret);
    // Compare fixed-size digests without an early return on differing bytes.
    let diff = 0;
    for (let i = 0; i < 64; i++) diff |= digest.charCodeAt(i) ^ row.withdraw_hash.charCodeAt(i);
    return diff === 0;
  }
  return false;
}
async function detail(db: ReportsDatabase, row: ReportRow) {
  const notes = await sql(db, 'SELECT * FROM notes WHERE report_id=? ORDER BY n', row.id).all();
  const { withdraw_hash: _withdraw, payload_hash: _payload, request_id: _request, ...safe } = row;
  void _withdraw;
  void _payload;
  void _request;
  const reporter =
    row.reporter_id === null
      ? null
      : await sql(
          db,
          'SELECT filed,accepted,rejected FROM reporters WHERE id=?',
          row.reporter_id,
        ).first();
  const events = await sql(
    db,
    'SELECT at,actor_id,actor_login,action,from_status,to_status,reason FROM events WHERE report_id=? ORDER BY at DESC LIMIT 100',
    row.id,
  ).all();
  return {
    ...safe,
    reporter_id: row.status === 'withdrawn' ? null : row.reporter_id,
    notes: notes.results,
    reporter_history: row.status === 'withdrawn' ? null : reporter,
    events: events.results,
  };
}
async function reporterDetail(db: ReportsDatabase, row: ReportRow) {
  const safe = await sql(
    db,
    'SELECT id,owner_hash,viewed_hash,variant,lang,seen_lang,rev,data_commit,status,category,note,source_url,src,links,created_at,updated_at,closed_note,files_count,files_bytes FROM reports WHERE id=?',
    row.id,
  ).first();
  const notes = await sql(
    db,
    'SELECT n,category,text,exact,prefix,suffix,start,end,line,whole,rev FROM notes WHERE report_id=? ORDER BY n',
    row.id,
  ).all();
  return { ...safe, notes: notes.results };
}

export async function reports(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  const db = reportDB(env);
  // Public endpoints do not resolve an identity or access GitHub.
  if (method === 'GET' && path === '/reports/public') {
    const hash = hashParam(url.searchParams.get('hash') ?? '');
    const lang = reportLang(url.searchParams.get('lang'));
    return json(
      (
        await sql(
          db,
          "SELECT n.n,n.category,r.status,r.created_at AS age,r.variant,COALESCE(n.rev,r.rev) AS rev,n.start,n.end FROM reports r JOIN notes n ON n.report_id=r.id WHERE r.owner_hash=? AND r.lang=? AND r.status IN ('open','triaged') LIMIT 100",
          hash,
          lang,
        ).all()
      ).results,
    );
  }
  const receipt = /^\/reports\/r\/(r-[a-z2-7]{8})(?:\/(view|withdraw))?$/.exec(path);
  if (receipt && method === 'GET' && !receipt[2]) {
    const row = await sql(
      db,
      'SELECT status,closed_note FROM reports WHERE id=?',
      receipt[1],
    ).first();
    if (!row) throw new HttpError(404, 'Report not found');
    return json(row);
  }
  const user = request.headers.has('Authorization') ? await identity(request, env) : undefined;
  let access: Access | undefined;
  const getAccess = async () => {
    if (!user) return undefined;
    const key = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.DATA_BRANCH}`;
    if (
      reportPermissionsCache?.key === key &&
      reportPermissionsCache.until > Date.now() &&
      (method === 'GET' || !reportPermissionsCache.users[String(user.id)])
    )
      access = reportPermissionsCache.users[String(user.id)];
    else {
      const github = new GitHub(env);
      const config = await permissions(github, await github.head());
      access = config.users[String(user.id)];
      // A cached absence can only deny privileges. Every positive write-role
      // decision still re-reads permissions; anonymous/account admission stays
      // protected by Turnstile and D1 rather than spending GitHub calls per try.
      reportPermissionsCache = { key, until: Date.now() + 60_000, users: config.users };
    }
    return access;
  };
  if (path === '/reports' && method === 'POST') return submit(request, env, db, user, getAccess);
  if (receipt && method === 'POST' && receipt[2]) {
    const input = await body(
      request,
      z.object({ secret: z.string().max(128).optional() }).strict(),
      512,
    );
    const row = await reportRow(db, receipt[1]);
    const own = await reportOwn(row, user, input.secret);
    if (receipt[2] === 'view') {
      if (own) return json(await reporterDetail(db, row));
      reportAccess(await getAccess(), row.lang);
      return json(await detail(db, row));
    }
    if (!own) throw new HttpError(403, 'Receipt access denied');
    if (!['open', 'triaged', 'withdrawn'].includes(row.status))
      throw new HttpError(409, 'Only open reports may be withdrawn');
    await deleteReportFiles(env, row.id);
    const result = await db.batch([
      sql(
        db,
        "UPDATE reports SET status='withdrawn',note='',links='[]',source_url=NULL,src=NULL,reporter_login=NULL,closed_note=NULL,files_count=0,files_bytes=0,version=version+1,updated_at=? WHERE id=? AND status IN ('open','triaged') AND version=?",
        now(),
        row.id,
        row.version,
      ),
      sql(
        db,
        "DELETE FROM notes WHERE report_id=? AND EXISTS(SELECT 1 FROM reports WHERE id=? AND status='withdrawn')",
        row.id,
        row.id,
      ),
      sql(
        db,
        "DELETE FROM events WHERE report_id=? AND EXISTS(SELECT 1 FROM reports WHERE id=? AND status='withdrawn')",
        row.id,
        row.id,
      ),
    ]);
    if (!result[0].meta.changes && row.status !== 'withdrawn')
      throw new HttpError(409, 'Report changed; reload');
    return json({ id: row.id, status: 'withdrawn' });
  }
  if (method === 'GET' && path === '/reports/mine') {
    if (!user) throw new HttpError(401, 'Sign in required');
    return json(
      (
        await sql(
          db,
          'SELECT id,status,owner_hash,lang,created_at,updated_at,closed_note FROM reports WHERE reporter_id=? ORDER BY created_at DESC LIMIT 200',
          user.id,
        ).all()
      ).results,
    );
  }
  const attachment = /^\/reports\/(r-[a-z2-7]{8})\/files(?:\/([1-3]))?$/.exec(path);
  if (attachment) {
    if (!user) throw new HttpError(401, 'Sign in required');
    const row = await reportRow(db, attachment[1]),
      files = env.REPORTS_FILES_DB;
    if (!files) throw new HttpError(503, 'Attachments are unavailable');
    const own = row.reporter_id === user.id;
    if (method === 'GET' && attachment[2]) {
      if (!own) reportAccess(await getAccess(), row.lang);
      if (['spam', 'withdrawn'].includes(row.status))
        throw new HttpError(404, 'Screenshot unavailable');
      const file = await sql(
        files,
        'SELECT mime,hex(bytes) AS hex FROM files WHERE report_id=? AND n=?',
        row.id,
        Number(attachment[2]),
      ).first<{ mime: string; hex: string }>();
      if (!file) throw new HttpError(404, 'Screenshot unavailable');
      const nativeHex = (
        Uint8Array as typeof Uint8Array & { fromHex?: (text: string) => Uint8Array<ArrayBuffer> }
      ).fromHex;
      const bytes = nativeHex ? nativeHex(file.hex) : new Uint8Array(file.hex.length / 2);
      if (!nativeHex)
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = Number.parseInt(file.hex.slice(i * 2, i * 2 + 2), 16);
      return new Response(bytes, {
        headers: {
          'Content-Type': file.mime,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Disposition': 'inline',
          Vary: 'Authorization',
        },
      });
    }
    if (method === 'DELETE' && attachment[2]) {
      if (!(own && ['open', 'triaged'].includes(row.status))) reportMaintainer(await getAccess());
      await sql(
        files,
        'DELETE FROM files WHERE report_id=? AND n=?',
        row.id,
        Number(attachment[2]),
      ).run();
      const totals = await sql(
        files,
        'SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM files WHERE report_id=?',
        row.id,
      ).first<{ n: number; bytes: number }>();
      await sql(
        db,
        'UPDATE reports SET files_count=?,files_bytes=? WHERE id=?',
        totals!.n,
        totals!.bytes,
        row.id,
      ).run();
      await sql(
        db,
        "INSERT INTO events(report_id,at,actor_id,actor_login,action) VALUES(?,?,?,?,'delete-attachment')",
        row.id,
        now(),
        user.id,
        user.login,
      ).run();
      return json({ deleted: true });
    }
    if (method === 'POST' && !attachment[2]) {
      if (!own) throw new HttpError(403, 'Only the reporter may upload');
      if (
        !['open', 'triaged'].includes(row.status) ||
        now() - row.created_at > 600 ||
        request.headers.get('X-Report-Request-Id') !== row.request_id
      )
        throw new HttpError(403, 'Upload key expired or invalid');
      const image = reportImage(await reportImageBody(request));
      if (request.headers.get('Content-Type') !== image.mime)
        throw new HttpError(415, 'Screenshot type does not match');
      const size = await files
        .prepare("SELECT value FROM meta WHERE key='size_after'")
        .first<{ value: string }>();
      if (Number(size?.value ?? 0) > 450_000_000)
        throw new HttpError(503, 'Attachments are full; link a video instead');
      const day = Math.floor(now() / 86400),
        key = `files:${user.id}:${day}`;
      const hash = await crypto.subtle.digest('SHA-256', image.bytes);
      const sha = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      // Bind one string, then decode in SQLite: D1's byte-array binding validates
      // half a million JS numbers synchronously for a maximum-size screenshot.
      // toHex is native in the pinned workerd runtime; the fallback is bounded.
      const nativeHex = (image.bytes as Uint8Array & { toHex?: () => string }).toHex;
      const blob = nativeHex
        ? nativeHex.call(image.bytes)
        : Array.from(image.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      try {
        const result = await files.batch([
          sql(
            files,
            'INSERT INTO limits VALUES(?,1,30,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
            key,
            (day + 1) * 86400,
          ),
          files
            .prepare(
              'INSERT INTO files(report_id,n,reporter_id,mime,size,sha256,created_at,bytes) SELECT ?,COALESCE((SELECT n FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3) WHERE n NOT IN (SELECT n FROM files WHERE report_id=?) ORDER BY n LIMIT 1),4),?,?,?,?,?,unhex(?)',
            )
            .bind(row.id, row.id, user.id, image.mime, image.bytes.length, sha, now(), blob),
        ]);
        await sql(
          files,
          "UPDATE meta SET value=? WHERE key='size_after'",
          String(result[1].meta.size_after ?? 0),
        ).run();
      } catch (error) {
        if (String(error).includes('REPORT_FILES_CLOSED'))
          throw new HttpError(409, 'Screenshots were removed from this report; uploads are closed');
        if (String(error).includes('CHECK constraint'))
          throw new HttpError(429, 'Screenshot limit reached');
        throw new HttpError(503, 'Attachments are unavailable');
      }
      const current = await sql(
        db,
        "UPDATE reports SET files_count=files_count+1,files_bytes=files_bytes+? WHERE id=? AND status IN ('open','triaged')",
        image.bytes.length,
        row.id,
      ).run();
      if (!current.meta.changes) {
        await deleteReportFiles(env, row.id);
        throw new HttpError(409, 'Report is no longer open');
      }
      return json({ uploaded: true }, 201);
    }
  }
  access = await getAccess();
  reportAccess(access);
  if (method === 'GET' && path === '/reports/index') {
    const cached = await db
      .prepare("SELECT value FROM meta WHERE key='marker_rev'")
      .first<{ value: string }>();
    const headers = {
      ETag: `"${cached!.value}"`,
      'Cache-Control': 'private, max-age=300',
      Vary: 'Authorization',
      'Access-Control-Expose-Headers': 'ETag',
    };
    if (request.headers.get('If-None-Match') === headers.ETag)
      return new Response(null, { status: 304, headers });
    // Snapshot revision and counts together: never label an old snapshot with a new revision.
    const result = await db.batch([
      db.prepare("SELECT value FROM meta WHERE key='marker_rev'"),
      db.prepare('SELECT owner_hash,lang,n FROM open_counts WHERE n>0'),
    ]);
    // D1 batch read results have the same result shape as all().
    const rows = result;
    const rev = String(rows[0].results[0].value),
      etag = `"${rev}"`;
    headers.ETag = etag;
    const open: Record<string, Record<string, number>> = {};
    for (const row of rows[1].results) (open[row.owner_hash] ??= {})[row.lang] = Number(row.n);
    return new Response(JSON.stringify({ v: 1, rev, open }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
  if (method === 'GET' && path === '/reports') {
    const hash = hashParam(url.searchParams.get('hash') ?? '');
    const lang = reportLang(url.searchParams.get('lang'));
    reportAccess(access, lang);
    const rows = await sql(
      db,
      'SELECT * FROM reports WHERE owner_hash=? AND lang=? ORDER BY created_at DESC,id DESC LIMIT 200',
      hash,
      lang,
    ).all<ReportRow>();
    const notes = await sql(
      db,
      'SELECT n.* FROM notes n WHERE n.report_id IN (SELECT id FROM reports WHERE owner_hash=? AND lang=? ORDER BY created_at DESC,id DESC LIMIT 200) ORDER BY n.n LIMIT 1000',
      hash,
      lang,
    ).all<{ report_id: string }>();
    const histories = await sql(
      db,
      'SELECT * FROM reporters WHERE id IN (SELECT reporter_id FROM reports WHERE owner_hash=? AND lang=? ORDER BY created_at DESC,id DESC LIMIT 200)',
      hash,
      lang,
    ).all<{ id: number }>();
    return json(
      rows.results.map((row) => {
        const {
          withdraw_hash: _withdraw,
          payload_hash: _payload,
          request_id: _request,
          ...safe
        } = row;
        void _withdraw;
        void _payload;
        void _request;
        return {
          ...safe,
          reporter_id: row.status === 'withdrawn' ? null : row.reporter_id,
          notes: notes.results.filter((n) => n.report_id === row.id),
          reporter_history:
            row.status === 'withdrawn'
              ? null
              : (histories.results.find((h) => h.id === row.reporter_id) ?? null),
        };
      }),
    );
  }
  if (method === 'GET' && path === '/reports/admin') {
    reportMaintainer(access);
    if (!env.REPORTS_FILES_DB) throw new HttpError(503, 'Attachments are unavailable');
    return json({
      files: await env.REPORTS_FILES_DB.prepare(
        "SELECT value AS size_after FROM meta WHERE key='size_after'",
      ).first(),
    });
  }
  if (method === 'GET' && path === '/reports/list') {
    const conditions: string[] = [],
      values: (string | number)[] = [];
    if (access!.role === 'translator') {
      const langs = access!.languages ?? [];
      if (!langs.length) return json({ rows: [], cursor: null });
      conditions.push(`lang IN (${langs.map(() => '?').join(',')})`);
      values.push(...langs);
    }
    for (const key of ['status', 'lang', 'category'] as const) {
      const value = url.searchParams.get(key);
      if (value) {
        conditions.push(`${key}=?`);
        values.push(value);
      }
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      const parts = cursor.split(':');
      const owner = hashParam(parts[0]);
      const lang = reportLang(parts[1] ?? null);
      conditions.push('(owner_hash,lang)>(?,?)');
      values.push(owner, lang);
    }
    if (!url.searchParams.has('status')) conditions.push("status IN ('open','triaged','fixed')");
    const since = url.searchParams.get('since');
    if (since) {
      const time = Number(since);
      if (!Number.isSafeInteger(time) || time < 0) throw new HttpError(400, 'Invalid age filter');
    }
    if (url.searchParams.get('signed_in') === '1') conditions.push("trust IN ('account','role')");
    const result = await sql(
      db,
      `SELECT owner_hash,lang,SUM(n) AS reports,MIN(created_at) AS created_at,MAX(updated_at) AS updated_at,SUM(CASE WHEN status IN ('open','triaged') THEN n ELSE 0 END) AS open,SUM(CASE WHEN status='fixed' THEN n ELSE 0 END) AS awaiting_publish,MAX(trust='role') AS has_role,MAX(trust<>'anonymous') AS has_account FROM report_rollups INDEXED BY rollups_list ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} GROUP BY owner_hash,lang ${since ? 'HAVING MIN(created_at)>=?' : ''} ORDER BY owner_hash,lang LIMIT 201`,
      ...values,
      ...(since ? [Number(since)] : []),
    ).all();
    const rows = result.results.slice(0, 200);
    const last = rows.at(-1);
    const representation = {
      rows,
      cursor: result.results.length > 200 ? `${last?.owner_hash}:${last?.lang}` : null,
    };
    const etag = `"${await reportDigest(JSON.stringify(representation))}"`;
    if (request.headers.get('If-None-Match') === etag)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization',
          'Access-Control-Expose-Headers': 'ETag',
        },
      });
    const response = json(representation);
    response.headers.set('ETag', etag);
    response.headers.set('Cache-Control', 'private, max-age=0');
    response.headers.set('Vary', 'Authorization');
    response.headers.set('Access-Control-Expose-Headers', 'ETag');
    return response;
  }
  if (method === 'POST' && path === '/reports/admin') {
    reportMaintainer(access);
    const input = await body(
      request,
      z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('pause'),
            scope: z.enum(['all', 'anonymous']),
            value: z.boolean(),
          })
          .strict(),
        z
          .object({ action: z.enum(['block', 'unblock']), id: z.number().int().positive() })
          .strict(),
        z.object({ action: z.literal('purge-now') }).strict(),
      ]),
      512,
    );
    if (input.action === 'pause')
      await sql(
        db,
        'UPDATE meta SET value=? WHERE key=?',
        input.value ? '1' : '0',
        `pause_${input.scope}`,
      ).run();
    else if (input.action === 'block')
      await sql(
        db,
        'INSERT OR REPLACE INTO blocked(reporter_id,by,at) VALUES(?,?,?)',
        input.id,
        user!.login,
        now(),
      ).run();
    else if (input.action === 'unblock')
      await sql(db, 'DELETE FROM blocked WHERE reporter_id=?', input.id).run();
    else await purgeReports(env);
    return json({ ok: true });
  }
  const item = /^\/reports\/(r-[a-z2-7]{8})(?:\/(action))?$/.exec(path);
  if (item) {
    const row = await reportRow(db, item[1]);
    reportAccess(access, row.lang);
    if (method === 'DELETE' && !item[2]) {
      reportMaintainer(access);
      await deleteReportFiles(env, row.id);
      await sql(db, 'DELETE FROM reports WHERE id=?', row.id).run();
      return json({ deleted: true });
    }
    if (method === 'POST' && item[2]) {
      const input = await body(request, reportActionSchema, 8192);
      if (input.expected_version !== row.version)
        throw new HttpError(409, 'Report changed; reload');
      if (row.status === 'withdrawn') throw new HttpError(409, 'Report withdrawn');
      if (row.status === 'spam') reportMaintainer(access);
      const fields: string[] = [],
        params: (string | number | null)[] = [];
      const set = (key: string, value: string | number | null) => {
        fields.push(`${key}=?`);
        params.push(value);
      };
      const active = ['open', 'triaged'].includes(row.status);
      let status = row.status;
      if (input.action === 'triage') {
        if (!active) throw new HttpError(409, 'Report is resolved');
        status = 'triaged';
      }
      if (input.action === 'claim') {
        if (!active) throw new HttpError(409, 'Report is resolved');
        set('claimed_by', user!.login);
        status = 'triaged';
      }
      if (input.action === 'resolve') {
        if (!active || !input.commit || !input.publishable)
          throw new HttpError(400, 'Open report, commit, and publishable hash required');
        const github = new GitHub(env),
          head = await github.head();
        const query = new URLSearchParams({
          sha: head,
          path: `tooltips/${row.owner_hash}.json`,
          per_page: '1',
        });
        const history = historySchema.parse(await github.result(`/commits?${query}`));
        const [file, aliases] = await github.files(
          [`tooltips/${row.owner_hash}.json`, 'aliases.json'],
          head,
        );
        if (
          history[0]?.sha !== input.commit ||
          !file ||
          (await publishableHash(
            tooltipSchema.parse(file.value),
            aliasesSchema.parse(aliases?.value ?? {}),
          )) !== input.publishable
        )
          throw new HttpError(409, 'Fix does not match the latest tooltip save');
        status = 'fixed';
        set('fix_commit', input.commit);
        set('fix_publishable', input.publishable);
        set('fixed_by', user!.login);
        set('fixed_at', now());
        set('published_at', null);
      }
      if (input.action === 'confirmPublished') {
        if (row.status !== 'fixed' || input.publishable !== row.fix_publishable)
          throw new HttpError(409, 'Fix evidence changed');
        const github = new GitHub(env),
          head = await github.head();
        const pushed = pushedSchema.parse(
          (await github.requiredFile('live/pushed.json', head)).value,
        );
        if (pushed[row.owner_hash] !== input.publishable)
          throw new HttpError(409, 'Fix is not published');
        if (!row.published_at) set('published_at', now());
      }
      if (input.action === 'reopen') {
        if (active) throw new HttpError(409, 'Report already open');
        status = 'open';
        set('published_at', null);
      }
      if (input.action === 'close') status = 'closed';
      if (input.action === 'reject') {
        if (!input.reason) throw new HttpError(400, 'Reason required');
        status = 'rejected';
        set('closed_note', input.reason);
      }
      if (input.action === 'duplicate') {
        if (!input.of || input.of === row.id) throw new HttpError(400, 'Duplicate target required');
        const target = await reportRow(db, input.of);
        reportAccess(access, target.lang);
        if (
          target.owner_hash !== row.owner_hash ||
          target.lang !== row.lang ||
          ['duplicate', 'withdrawn', 'spam'].includes(target.status)
        )
          throw new HttpError(400, 'Invalid duplicate target');
        status = 'duplicate';
        set('duplicate_of', target.id);
      }
      if (input.action === 'spam') {
        reportMaintainer(access);
        await deleteReportFiles(env, row.id);
        set('files_count', 0);
        set('files_bytes', 0);
        status = 'spam';
      }
      if (input.action === 'closedNote') {
        if (input.text === undefined) throw new HttpError(400, 'Text required');
        set('closed_note', input.text);
      }
      const extra: ReportStatement[] = [];
      if (input.action === 'reanchor') {
        if (!input.n || !input.anchor) throw new HttpError(400, 'Note and anchor required');
        const note = await sql(
          db,
          'SELECT n FROM notes WHERE report_id=? AND n=?',
          row.id,
          input.n,
        ).first();
        if (!note) throw new HttpError(404, 'Note not found');
        const a = input.anchor;
        extra.push(
          sql(
            db,
            'UPDATE notes SET prev_rev=rev,prev_exact=exact,prev_prefix=prefix,prev_suffix=suffix,prev_start=start,prev_end=end,rev=?,exact=?,prefix=?,suffix=?,start=?,end=?,line=?,whole=0 WHERE report_id=? AND n=? AND changes()>0',
            a.rev,
            a.exact,
            a.prefix,
            a.suffix,
            a.start,
            a.end,
            a.line,
            row.id,
            input.n,
          ),
        );
      }
      set('status', status);
      set('updated_at', now());
      const result = await db.batch([
        sql(
          db,
          `UPDATE reports SET ${fields.join(',')},version=version+1 WHERE id=? AND version=?`,
          ...params,
          row.id,
          row.version,
        ),
        ...extra,
        sql(
          db,
          'INSERT INTO events(report_id,at,actor_id,actor_login,action,from_status,to_status,reason) SELECT ?,?,?,?,?,?,?,? WHERE changes()>0',
          row.id,
          now(),
          user!.id,
          user!.login,
          input.action,
          row.status,
          status,
          input.reason ?? null,
        ),
      ]);
      if (!result[0].meta.changes) throw new HttpError(409, 'Report changed; reload');
      return json({ id: row.id, status, version: row.version + 1 });
    }
  }
  throw new HttpError(404, 'Endpoint not found');
}
export async function deleteReportFiles(env: Env, id: string) {
  if (!env.REPORTS_FILES_DB) throw new HttpError(503, 'Attachments are unavailable');
  await env.REPORTS_FILES_DB.batch(closeReportFiles(env.REPORTS_FILES_DB, id));
}
function closeReportFiles(files: ReportsDatabase, id: string): ReportStatement[] {
  return [
    sql(files, 'INSERT OR IGNORE INTO files_closed(report_id) VALUES(?)', id),
    sql(files, 'DELETE FROM files WHERE report_id=?', id),
  ];
}

/** Hourly, bounded batches: 1536 reports/day covers the public ceiling plus role holders. */
export async function purgeReports(env: Env) {
  const db = reportDB(env),
    files = env.REPORTS_FILES_DB,
    time = now();
  if (!files) throw new HttpError(503, 'Attachments are unavailable');
  const statuses = [
    'open',
    'triaged',
    'spam',
    'fixed',
    'closed',
    'rejected',
    'duplicate',
    'withdrawn',
  ];
  const pages = await db.batch(
    statuses.map((status) =>
      sql(
        db,
        'SELECT id,status,version,updated_at FROM reports INDEXED BY reports_purge WHERE status=? AND updated_at<? ORDER BY updated_at,id LIMIT 64',
        status,
        time - (['open', 'triaged'].includes(status) ? 365 : status === 'spam' ? 7 : 180) * 86400,
      ),
    ),
  );
  // At most 8 x 64 covered index entries, regardless of retained history.
  const candidates = {
    results: pages
      .flatMap((page) =>
        page.results.map((row) => ({
          id: String(row.id),
          status: String(row.status),
          version: Number(row.version),
          updated_at: Number(row.updated_at),
        })),
      )
      .sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 64),
  };
  // Stale open reports close now and retain screenshots for the terminal
  // 30-day grace. Physical report deletion is files-first and retryable.
  const deleting = candidates.results.filter((row) => !['open', 'triaged'].includes(row.status));
  if (deleting.length)
    await files.batch(deleting.flatMap((row) => closeReportFiles(files, row.id)));
  await db.batch([
    ...candidates.results.map((row) =>
      ['open', 'triaged'].includes(row.status)
        ? sql(
            db,
            "UPDATE reports SET status='closed',closed_note='stale',version=version+1,updated_at=? WHERE id=? AND version=?",
            time,
            row.id,
            row.version,
          )
        : sql(db, 'DELETE FROM reports WHERE id=? AND version=?', row.id, row.version),
    ),
    sql(
      db,
      'DELETE FROM limits WHERE key IN (SELECT key FROM limits WHERE expires_at<? ORDER BY expires_at LIMIT 1000)',
      time,
    ),
    sql(
      db,
      "DELETE FROM meta WHERE key='daily_salt' AND substr(value,1,instr(value,':')-1)<>?",
      String(Math.floor(time / 86400)),
    ),
  ]);
  const cursor = await files
    .prepare("SELECT value FROM meta WHERE key='sweep_cursor'")
    .first<{ value: string }>();
  const page = await sql(
    files,
    'SELECT DISTINCT report_id FROM files WHERE report_id>? ORDER BY report_id LIMIT 64',
    cursor?.value ?? '',
  ).all<{ report_id: string }>();
  const ids = page.results.map((r) => r.report_id);
  const rows = ids.length
    ? await sql(
        db,
        `SELECT id,status,updated_at FROM reports WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      ).all<ReportRow>()
    : { results: [] };
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  const expired = ids.filter((id) => {
    const row = byId.get(id);
    return (
      !row || (!['open', 'triaged'].includes(row.status) && row.updated_at < time - 30 * 86400)
    );
  });
  await files.batch([
    ...expired.flatMap((id) => closeReportFiles(files, id)),
    sql(
      files,
      'DELETE FROM limits WHERE key IN (SELECT key FROM limits WHERE expires_at<? LIMIT 1000)',
      time,
    ),
    sql(
      files,
      "INSERT INTO meta VALUES('sweep_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ids.length === 64 ? ids.at(-1)! : '',
    ),
  ]);
  if (expired.length)
    await db.batch(
      expired.map((id) => sql(db, 'UPDATE reports SET files_count=0,files_bytes=0 WHERE id=?', id)),
    );
}
