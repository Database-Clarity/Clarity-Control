// Export projects (spec sections 4 and 5): partner configs stored in editor-data
// `exports/projects/<id>.json`, partner membership in `config/permissions.json` `partners`.
//
// Every write follows one pattern: ONE GraphQL read of the data-branch head (permissions, the
// config blob and its SHA, the last commit that touched it), authorisation and every check
// against that head, then a commit whose sole parent is that head (ref CAS, `force: false`).
// When the branch moved, the whole read and every check run again (at most 3 attempts), so a
// revoked partner, a deleted project, a newer config, or a fresh cooldown always wins.
// Validation is `@clarity/export/config` itself, never a copy.
import { z, ZodError } from 'zod';
import { permissionsSchema, type Permissions } from '@clarity/core';
import {
  configLimits,
  configSchema,
  immutableChanges,
  isLegacyFile,
  isValidId,
  migrateConfig,
  type ExportConfig,
  type ExportFile,
} from '@clarity/export/config';
import { blobContent, blobSha, RefRace, type ExportsSnapshot, type GitHub } from './github.js';
import { body, HttpError, json, upstreamJson } from './http.js';
import { partnerProjects } from './permissions.js';
import type { Identity } from './types.js';

/** A partner (or maintainer) may save one project's config at most once per 30 s. */
export const cooldownMs = 30_000;
/** Retained URLs keep updating for 3 months from the save that retired them (spec section 5). */
export const retainMonths = 3;
/** Workload bound (spec section 3): at most 40 projects. */
export const maxProjects = 40;
/** Partners per project, and logins looked up per request (one subrequest each). */
export const maxPartners = 10;
const attempts = 3;

type Retained = NonNullable<ExportConfig['retained']>[number];
type Role = { maintainer: boolean; projects: readonly string[] };

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const loginSchema = z
  .string()
  .trim()
  .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i, 'Enter a GitHub login');
const createSchema = z.strictObject({ config: z.unknown() });
const updateSchema = z.strictObject({ revision, config: z.unknown() });
const deleteSchema = z.strictObject({ revision });
const partnersSchema = z.strictObject({
  /** The permissions.json blob SHA the maintainer loaded (`partnersRevision`). */
  revision,
  logins: z
    .array(loginSchema)
    .max(maxPartners)
    .refine(
      (list) => new Set(list.map((login) => login.toLowerCase())).size === list.length,
      'Duplicate login',
    ),
});

export const projectPath = (id: string) => `exports/projects/${id}.json`;

/**
 * zod builds a schema's internals on its first parse (~4 ms for the config schema). One parse
 * of a small sample here, at module load, moves that one-time cost to isolate startup (its own
 * limit) instead of the first request's CPU (export spec section 4: Free-plan budget).
 */
function warmSchemas(): void {
  const file = {
    id: 'warm',
    uid: 'warmwarmwarmwarm',
    formatVersion: 1,
    preset: 'markdown',
    shape: 'lines',
    data: {
      categories: ['warm'],
      sandboxPerks: [],
      frameAliases: false,
      languages: ['en'],
      keys: ['name'],
      bungieIdentical: false,
    },
    format: {
      symbols: { arc: { mode: 'keep' }, bold: { mode: 'replace', before: '*', after: '*' } },
      titles: { mode: 'inline', pattern: ['', '', '', ''] },
      links: { mode: 'replace', pattern: ['', '', '', ''] },
      elementTags: false,
      spacer: 'keep',
    },
  };
  const legacy = { id: 'legacy', uid: 'legacylegacyleg1', formatVersion: 1, preset: 'dim' };
  configSchema.safeParse({
    schema: 1,
    id: 'warm',
    name: 'Warm',
    files: [file, legacy],
    retained: [
      {
        path: 'warm/v1/old.json',
        uid: 'oldoldoldoldoldo',
        formatVersion: 1,
        snapshot: { ...legacy, id: 'old', uid: 'oldoldoldoldoldo' },
        until: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  permissionsSchema.safeParse({ users: {}, partners: { '1': { login: 'w', projects: ['warm'] } } });
  const revision = '0'.repeat(40);
  updateSchema.safeParse({ revision, config: {} });
  partnersSchema.safeParse({ revision, logins: ['warm'] });
  deleteSchema.safeParse({ revision });
  createSchema.safeParse({ config: {} });
}
warmSchemas();
/** Same as the engine's `<project>/v<format>/<file>.json` (config.ts and project.ts). */
const urlPath = (project: string, file: Pick<ExportFile, 'id' | 'formatVersion'>) =>
  `${project}/v${file.formatVersion}/${file.id}.json`;

function projectParam(raw: string): string {
  if (!isValidId(raw)) throw new HttpError(404, 'Export project not found');
  return raw;
}

function role(config: Permissions, user: Identity): Role {
  return {
    maintainer: config.users[String(user.id)]?.role === 'maintainer',
    projects: partnerProjects(config, user),
  };
}

/** Maintainers always; partners only for a project listed under their id. Others: 403. */
function requireProject(role: Role, project: string | null): void {
  if (role.maintainer) return;
  if (project === null || !role.projects.includes(project))
    throw new HttpError(403, 'Permission denied');
}

function permissionsAt(snapshot: ExportsSnapshot): Permissions {
  return permissionsSchema.parse(snapshot.permissions.value);
}

/** A stored config, migrated to the current schema (spec section 5); invalid storage is a 502. */
function stored(file: { value: unknown }, id: string): ExportConfig {
  let config: ExportConfig;
  try {
    config = migrateConfig(file.value);
  } catch {
    throw new HttpError(502, `Stored export config is invalid: ${id}`);
  }
  if (config.id !== id) throw new HttpError(502, `Stored export config id mismatch: ${id}`);
  return config;
}

/**
 * A client config, migrated then validated; every problem is a 400 with the zod issues.
 * `retained` is server-owned and checked against the stored list later. It is validated on its
 * own (with no active files) because a save that switches a file back to its retained URL
 * legitimately sends that URL twice: active and, still, retained.
 */
function incoming(raw: unknown): ExportConfig {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('retained' in raw))
      return migrateConfig(raw);
    const { retained, ...rest } = raw as Record<string, unknown>;
    const config = migrateConfig(rest);
    const own = migrateConfig({ ...rest, files: [], retained }).retained;
    return own === undefined ? config : { ...config, retained: own };
  } catch (error) {
    if (error instanceof ZodError) throw new HttpError(400, 'Invalid export config', error.issues);
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid export config');
  }
}

function validated(config: unknown): ExportConfig {
  const result = configSchema.safeParse(config);
  if (!result.success) throw new HttpError(400, 'Invalid export config', result.error.issues);
  return result.data;
}

const uidAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';
/** 16 random base32 characters (80 bits): a file's server-assigned, immutable URL owner. */
export function newUid(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => uidAlphabet[byte & 31])
    .join('');
}

/** `now` plus `retainMonths` calendar months, UTC, ISO 8601. */
export function retainUntil(now: Date): string {
  const until = new Date(now.getTime());
  until.setUTCMonth(until.getUTCMonth() + retainMonths);
  return until.toISOString();
}

/**
 * Server-owned retained entries for a save (spec section 5). `previous` is the stored config,
 * `next` the accepted config with every uid assigned and `retained` as the caller may keep it.
 * - A file whose URL changes (format switch or rename) or that is removed leaves an entry for
 *   its old URL: snapshot = its last saved config, until = now + 3 months. Existing entries are
 *   kept as they are, so a window is never shortened.
 * - A file that returns to a URL its own uid retained takes it back: that entry is dropped.
 * Returns the list, or the problems (more than 2 entries for a file, more than 6 URLs).
 */
export function planRetained(
  previous: ExportConfig,
  next: ExportConfig,
  now: Date,
): { retained: Retained[]; problems: string[] } {
  const until = retainUntil(now);
  const nextByUid = new Map(next.files.map((file) => [file.uid, file]));
  let retained = [...(next.retained ?? [])];
  for (const file of previous.files) {
    if (!file.uid) continue;
    const path = urlPath(previous.id, file);
    const after = nextByUid.get(file.uid);
    if (after && urlPath(next.id, after) === path) continue;
    if (retained.some((entry) => entry.path === path)) continue;
    retained.push({
      path,
      uid: file.uid,
      formatVersion: file.formatVersion,
      snapshot: file,
      until,
    });
  }
  const active = new Set(next.files.map((file) => `${file.uid}\n${urlPath(next.id, file)}`));
  retained = retained.filter((entry) => !active.has(`${entry.uid}\n${entry.path}`));
  const problems: string[] = [];
  const windows = (list: Retained[]) =>
    list.map((entry) => `${entry.path} until ${entry.until.slice(0, 10)}`).join(', ');
  for (const file of next.files) {
    const own = retained.filter((entry) => entry.uid === file.uid);
    if (own.length > configLimits.retainedPerFile)
      problems.push(
        `File ${file.id} can keep at most ${configLimits.retainedPerFile} old URLs (${windows(own)}); a maintainer can delete one after its window ends`,
      );
  }
  const removed = new Map<string, number>();
  for (const entry of retained)
    if (!nextByUid.has(entry.uid)) removed.set(entry.uid, (removed.get(entry.uid) ?? 0) + 1);
  for (const [uid, count] of removed)
    if (count > configLimits.retainedPerFile)
      problems.push(
        `A removed file (${uid}) would keep more than ${configLimits.retainedPerFile} old URLs`,
      );
  const slots = next.files.length + retained.length;
  if (slots > configLimits.urlSlots)
    problems.push(
      `At most ${configLimits.urlSlots} URLs per project; this save needs ${slots}: ${next.files
        .map((file) => urlPath(next.id, file))
        .join(', ')}${retained.length ? `, retained ${windows(retained)}` : ''}`,
    );
  return { retained, problems };
}

/**
 * The accepted next config for a save by `role` (spec sections 4 and 5), or a 400/403 listing
 * every problem. Partners change only `files`; a maintainer may also rename the project and
 * delete retained entries whose window has ended. Uids and `retained` are server-owned.
 */
export function acceptSave(
  previous: ExportConfig,
  raw: ExportConfig,
  role: Role,
  now: Date,
): ExportConfig {
  const next: ExportConfig = structuredClone(raw);
  const problems: string[] = [];
  if (!role.maintainer) {
    if (next.name !== previous.name) problems.push('Only a maintainer can rename the project');
  }
  // `retained` is server-owned: omitted means "unchanged"; any other change is checked below.
  next.retained = next.retained ?? previous.retained;
  // A stored file without a uid (written outside the Worker) gets one now; a next file with the
  // same id and no uid is that same file.
  const before: ExportConfig = structuredClone(previous);
  for (const file of before.files) {
    if (file.uid) continue;
    file.uid = newUid();
    const same = next.files.find((candidate) => candidate.id === file.id && !candidate.uid);
    if (same) same.uid = file.uid;
  }
  problems.push(...immutableChanges(before, next, { maintainer: role.maintainer }));
  if (role.maintainer) {
    const kept = new Set((next.retained ?? []).map((entry) => JSON.stringify(entry)));
    for (const entry of before.retained ?? [])
      if (!kept.has(JSON.stringify(entry)) && Date.parse(entry.until) > now.getTime())
        problems.push(
          `The old URL ${entry.path} keeps updating until ${entry.until.slice(0, 10)}; it can be deleted after that`,
        );
  }
  if (problems.length)
    throw new HttpError(problems.some(isForbidden) ? 403 : 400, problems[0]!, problems);
  for (const file of next.files) file.uid ??= newUid();
  const plan = planRetained(before, next, now);
  if (plan.problems.length) throw new HttpError(400, plan.problems[0]!, plan.problems);
  if (plan.retained.length) next.retained = plan.retained;
  else delete next.retained;
  return validated(next);
}

const isForbidden = (problem: string) =>
  problem.startsWith('Only a maintainer') || problem === 'Retained URLs are server-owned';

/** Category ids a save adds that the generator head does not have (spec section 4). */
async function newUnknownCategories(
  github: GitHub,
  previous: ExportConfig | null,
  next: ExportConfig,
): Promise<string[]> {
  const named = (config: ExportConfig | null) =>
    new Set(
      (config?.files ?? []).flatMap((file) =>
        isLegacyFile(file) ? [] : [...file.data.categories, ...file.data.sandboxPerks],
      ),
    );
  const known = named(previous);
  const added = [...named(next)].filter((category) => !known.has(category));
  // Categories already stored are never re-checked: a category the generator later drops is a
  // build notice (spec section 5), not a reason to block the partner's next save.
  if (!added.length) return [];
  github.spend();
  const { GENERATOR_OWNER, GENERATOR_REPO, GENERATOR_BRANCH } = github.env;
  const categories = z
    .array(z.object({ id: z.string() }))
    .parse(
      await upstreamJson(
        await fetch(
          `https://raw.githubusercontent.com/${encodeURIComponent(GENERATOR_OWNER)}/${encodeURIComponent(
            GENERATOR_REPO,
          )}/${encodeURIComponent(GENERATOR_BRANCH)}/templates/v2/categories.json`,
        ),
      ),
    );
  const ids = new Set(categories.map((category) => category.id));
  return added.filter((category) => !ids.has(category)).sort();
}

async function checkCategories(github: GitHub, previous: ExportConfig | null, next: ExportConfig) {
  const unknown = await newUnknownCategories(github, previous, next);
  if (unknown.length)
    throw new HttpError(400, `Unknown item categories: ${unknown.join(', ')}`, unknown);
}

async function saved(config: ExportConfig) {
  return { revision: await blobSha(blobContent(config)), config };
}

/**
 * A list row (spec section 8, projects list): read straight from the stored JSON without the
 * schema, so listing the maximum of 40 projects stays inside the Free CPU budget. Null when the
 * stored file does not even have this shape. Full configs (migrated and validated) are served
 * one at a time by `?project=<id>`.
 */
function summary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { schema, name, files, retained } = value as Record<string, unknown>;
  if (typeof schema !== 'number' || typeof name !== 'string' || !Array.isArray(files)) return null;
  const rows = [];
  for (const file of files) {
    if (!file || typeof file !== 'object') return null;
    const { id, preset, formatVersion } = file as Record<string, unknown>;
    if (typeof id !== 'string' || typeof preset !== 'string' || typeof formatVersion !== 'number')
      return null;
    rows.push({ id, preset, formatVersion });
  }
  return {
    schema,
    name,
    files: rows,
    retained: Array.isArray(retained) ? retained.length : 0,
  };
}

/**
 * GET /exports/projects: list rows, every project for maintainers and their own for partners.
 * GET /exports/projects?project=<id>: that project's full config (migrated, validated) and
 * revision, for a maintainer or a partner of it.
 */
export async function listProjects(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const one = params.get('project');
  if ([...params.keys()].some((key) => key !== 'project') || params.getAll('project').length > 1)
    throw new HttpError(400, 'Only one project query parameter is allowed');
  if (one !== null) {
    const id = projectParam(one);
    const snapshot = await github.exportsRead(projectPath(id), false);
    const permissions = permissionsAt(snapshot);
    const who = role(permissions, user);
    requireProject(who, id);
    if (!snapshot.config) throw new HttpError(404, 'Export project not found');
    return json({
      head: snapshot.head,
      id,
      revision: snapshot.config.sha,
      config: stored(snapshot.config, id),
      ...(who.maintainer
        ? { partnersRevision: snapshot.permissions.sha, partners: members(permissions, id) }
        : {}),
    });
  }
  const snapshot = await github.exportsRead(null, 'blobs');
  const permissions = permissionsAt(snapshot);
  const who = role(permissions, user);
  if (!who.maintainer && !who.projects.length) throw new HttpError(403, 'Permission denied');
  const projects = [];
  for (const { id, file } of snapshot.projects ?? []) {
    if (!file || (!who.maintainer && !who.projects.includes(id))) continue;
    const row = summary(file.value);
    projects.push({
      id,
      revision: file.sha,
      // An unreadable stored config is listed (so a maintainer sees it), never served as valid.
      ...(row ?? { error: 'Stored config is invalid' }),
      ...(who.maintainer ? { partners: members(permissions, id) } : {}),
    });
  }
  return json({
    head: snapshot.head,
    ...(who.maintainer ? { partnersRevision: snapshot.permissions.sha } : {}),
    projects,
  });
}

const members = (permissions: Permissions, project: string) =>
  Object.entries(permissions.partners ?? {})
    .filter(([, entry]) => entry.projects.includes(project))
    .map(([partnerId, entry]) => ({ id: Number(partnerId), login: entry.login }));

/** POST /exports/projects (maintainer): a new project; its path must not exist yet. */
export async function createProject(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const input = await body(request, createSchema, 64_000);
  const raw = incoming(input.config);
  if (raw.retained?.length) throw new HttpError(400, 'Retained URLs are server-owned');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await github.exportsRead(projectPath(raw.id), 'names');
    requireProject(role(permissionsAt(snapshot), user), null);
    if (snapshot.config) throw new HttpError(409, `Export project ${raw.id} already exists`);
    if ((snapshot.projects?.length ?? 0) >= maxProjects)
      throw new HttpError(400, `At most ${maxProjects} export projects`);
    const empty: ExportConfig = { schema: raw.schema, id: raw.id, name: raw.name, files: [] };
    const problems = immutableChanges(empty, raw, { maintainer: true });
    if (problems.length) throw new HttpError(400, problems[0]!, problems);
    const config = validated({
      ...raw,
      files: raw.files.map((file) => ({ ...file, uid: newUid() })),
    });
    delete config.retained;
    await checkCategories(github, null, config);
    try {
      const commit = await github.commit(
        snapshot.head,
        { [projectPath(config.id)]: config },
        `Create export project ${config.id} by ${user.login}`,
        user,
        { baseTree: snapshot.tree },
      );
      return json({ commit, ...(await saved(config)) }, 201);
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry');
}

/** PUT /exports/projects/:id (maintainer, or a partner of :id): save the config. */
export async function updateProject(
  request: Request,
  github: GitHub,
  user: Identity,
  rawId: string,
): Promise<Response> {
  const id = projectParam(rawId);
  const input = await body(request, updateSchema, 64_000);
  const raw = incoming(input.config);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await github.exportsRead(projectPath(id), false);
    // Authorisation first, against this head: a revoked partner learns nothing more.
    const who = role(permissionsAt(snapshot), user);
    requireProject(who, id);
    if (!snapshot.config) throw new HttpError(404, 'Export project not found');
    if (snapshot.config.sha !== input.revision)
      throw new HttpError(409, 'The project changed since it was loaded; reload and retry');
    const now = new Date();
    const previous = stored(snapshot.config, id);
    const next = acceptSave(previous, raw, who, now);
    if (blobContent(next) === blobContent(previous))
      return json({ commit: null, revision: snapshot.config.sha, config: previous });
    const last = snapshot.lastCommit ? Date.parse(snapshot.lastCommit) : Number.NaN;
    if (now.getTime() - last < cooldownMs) {
      const wait = Math.ceil((last + cooldownMs - now.getTime()) / 1000);
      throw new HttpError(429, `Saved moments ago; save again in ${wait} s`, { retryAfter: wait });
    }
    await checkCategories(github, previous, next);
    try {
      const commit = await github.commit(
        snapshot.head,
        { [projectPath(id)]: next },
        `Update export project ${id} by ${user.login}`,
        user,
        { baseTree: snapshot.tree },
      );
      return json({ commit, ...(await saved(next)) });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry');
}

/**
 * DELETE /exports/projects/:id (maintainer): removes the config and the project from every
 * partner entry in the same commit, so a later project with the same id grants nobody access.
 */
export async function deleteProject(
  request: Request,
  github: GitHub,
  user: Identity,
  rawId: string,
): Promise<Response> {
  const id = projectParam(rawId);
  const input = await body(request, deleteSchema, 1_000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await github.exportsRead(projectPath(id), false);
    const permissions = permissionsAt(snapshot);
    requireProject(role(permissions, user), null);
    if (!snapshot.config) throw new HttpError(404, 'Export project not found');
    if (snapshot.config.sha !== input.revision)
      throw new HttpError(409, 'The project changed since it was loaded; reload and retry');
    let urls: string[] = [];
    try {
      const config = stored(snapshot.config, id);
      urls = [
        ...config.files.map((file) => urlPath(id, file)),
        ...(config.retained ?? []).map((entry) => entry.path),
      ];
    } catch (error) {
      // An unreadable config can still be deleted; it names no URLs we could list.
      if (!(error instanceof HttpError)) throw error;
    }
    const nextPermissions = withMembers(permissions, id, []);
    try {
      const commit = await github.commit(
        snapshot.head,
        nextPermissions === permissions ? {} : { 'config/permissions.json': nextPermissions },
        `Delete export project ${id} by ${user.login}`,
        user,
        { baseTree: snapshot.tree, deletions: [projectPath(id)] },
      );
      return json({ commit, removed: urls });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry');
}

/** `permissions` with exactly `members` (numeric id -> login) as partners of `project`. */
function withMembers(
  permissions: Permissions,
  project: string,
  members: readonly { id: string; login: string }[],
): Permissions {
  const partners: NonNullable<Permissions['partners']> = {};
  let changed = false;
  for (const [id, entry] of Object.entries(permissions.partners ?? {})) {
    const keep = members.some((member) => member.id === id);
    const has = entry.projects.includes(project);
    if (has === keep) {
      partners[id] = entry;
      continue;
    }
    changed = true;
    const projects = keep
      ? [...entry.projects, project]
      : entry.projects.filter((name) => name !== project);
    if (projects.length) partners[id] = { login: entry.login, projects };
  }
  for (const member of members) {
    if (partners[member.id] || permissions.partners?.[member.id]) continue;
    changed = true;
    partners[member.id] = { login: member.login, projects: [project] };
  }
  if (!changed) return permissions;
  const next: Permissions = { ...permissions };
  if (Object.keys(partners).length) next.partners = partners;
  else delete next.partners;
  return permissionsSchema.parse(next);
}

/**
 * PUT /exports/projects/:id/partners (maintainer): the full list of partner logins for :id.
 * A login already in `partners` keeps its numeric id; a new one is looked up on GitHub once,
 * before the retry loop, and stored by id (spec section 4).
 */
export async function setPartners(
  request: Request,
  github: GitHub,
  user: Identity,
  rawId: string,
): Promise<Response> {
  const id = projectParam(rawId);
  const input = await body(request, partnersSchema, 4_000);
  const resolved = new Map<string, { id: string; login: string }>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await github.exportsRead(projectPath(id), false);
    const permissions = permissionsAt(snapshot);
    requireProject(role(permissions, user), null);
    if (!snapshot.config) throw new HttpError(404, 'Export project not found');
    if (snapshot.permissions.sha !== input.revision)
      throw new HttpError(409, 'Permissions changed since they were loaded; reload and retry');
    const known = new Map(
      Object.entries(permissions.partners ?? {}).map(([partnerId, entry]) => [
        entry.login.toLowerCase(),
        { id: partnerId, login: entry.login },
      ]),
    );
    const members: { id: string; login: string }[] = [];
    for (const login of input.logins) {
      const key = login.toLowerCase();
      let member = known.get(key) ?? resolved.get(key);
      if (!member) {
        const account = await github.account(login);
        member = { id: String(account.id), login: account.login };
        resolved.set(key, member);
      }
      if (!members.some((entry) => entry.id === member.id)) members.push(member);
    }
    const next = withMembers(permissions, id, members);
    const partners = members.map((member) => ({ id: Number(member.id), login: member.login }));
    if (next === permissions)
      return json({ commit: null, partnersRevision: snapshot.permissions.sha, partners });
    try {
      const commit = await github.commit(
        snapshot.head,
        { 'config/permissions.json': next },
        `Update partners of export project ${id} by ${user.login}`,
        user,
        { baseTree: snapshot.tree },
      );
      return json({
        commit,
        partnersRevision: await blobSha(blobContent(next)),
        partners,
      });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry');
}

/** The /exports routes, or null when `path` is not one of them. */
export function exportsRoute(
  request: Request,
  path: string,
  github: GitHub,
  user: Identity,
): Promise<Response> | null {
  const { method } = request;
  if (path === '/exports/projects') {
    if (method === 'GET') return listProjects(request, github, user);
    if (method === 'POST') return createProject(request, github, user);
    return null;
  }
  const partners = /^\/exports\/projects\/([^/]+)\/partners$/.exec(path);
  if (partners && method === 'PUT') return setPartners(request, github, user, partners[1]!);
  const project = /^\/exports\/projects\/([^/]+)$/.exec(path);
  if (project && method === 'PUT') return updateProject(request, github, user, project[1]!);
  if (project && method === 'DELETE') return deleteProject(request, github, user, project[1]!);
  return null;
}
