import { z } from 'zod';
import { appJwt } from './crypto.js';
import { HttpError } from './http.js';
import type { Env, Identity } from './types.js';

const shaSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const fileSchema = shaSchema.extend({ content: z.string(), encoding: z.string() });
const refSchema = z.object({ object: shaSchema });
const commitSchema = z.object({ tree: shaSchema });

export class RefRace extends Error {}

/**
 * Cloudflare Workers FREE plan: 50 external subrequests per request. Every fetch() counts, so
 * operations spend from this budget and stop cleanly (503) before the platform would fail them
 * halfway through a write. Two calls are left spare.
 */
export const subrequestLimit = 48;
/** Blobs read per GraphQL call. Each call is one subrequest however many files it carries. */
export const blobsPerQuery = 500;
const refPattern = /^[0-9a-f]{40}$/;
// Plain repository paths, plus the publisher's own `.publisher/` folder (its PIN, see elementTags.ts).
const pathPattern = /^(?:\.publisher\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const blobFields = z.object({
  oid: z.string().regex(refPattern),
  isTruncated: z.boolean(),
  text: z.string().nullable(),
});
// `object` is null for a missing path and `{}` when the path is not a blob (the fragment misses).
const blobEntry = z.union([z.null(), z.object({}).strict(), blobFields]);
const graphqlSchema = z.object({
  data: z.object({ repository: z.record(z.string(), z.unknown()).nullable() }).nullable(),
  errors: z.array(z.unknown()).optional(),
});
const notFoundError = z.object({
  type: z.literal('NOT_FOUND'),
  path: z.tuple([z.literal('repository'), z.literal('ref'), z.literal('target'), z.string()]),
});
/**
 * GitHub reports a `Commit.file(path:)` that resolves to nothing as `null` data plus a top-level
 * NOT_FOUND error (`object(expression:)` is a silent `null`). Only that exact shape counts as a
 * missing file: the error must name one aliased field directly under the commit target, and that
 * field must be `null`. Any other error still fails the whole read (fail closed).
 */
function onlyMissingFiles(errors: readonly unknown[], repository: Record<string, unknown>) {
  const ref = z.object({ target: z.record(z.string(), z.unknown()) }).safeParse(repository.ref);
  if (!ref.success) return false;
  return errors.every((error) => {
    const parsed = notFoundError.safeParse(error);
    if (!parsed.success) return false;
    const alias = parsed.data.path[3];
    return Object.hasOwn(ref.data.target, alias) && ref.data.target[alias] === null;
  });
}

export interface RepoFile {
  sha: string;
  value: unknown;
}

/** A names-only directory entry; `entries` is set when the entry is a directory listed deeper. */
export interface TreeNode {
  name: string;
  entries?: TreeNode[];
}

/**
 * Parses a names-only `file(path){object{... on Tree{entries{...}}}}` selection (see
 * publishSnapshot `trees`). null: the path is missing or is not a directory. Hand-written rather
 * than a recursive zod schema: listings can hold thousands of names, and this runs in request CPU.
 */
function treeNodes(raw: unknown, depth: number): TreeNode[] | null {
  const bad = () => new HttpError(502, 'Invalid GitHub tree listing');
  const list = (object: unknown, level: number): TreeNode[] | null => {
    if (object === null || typeof object !== 'object') throw bad();
    const entries = (object as { entries?: unknown }).entries;
    if (entries === undefined) return null; // a blob, not a directory
    if (!Array.isArray(entries)) throw bad();
    return entries.map((entry: unknown) => {
      const { name, object: child } = (entry ?? {}) as { name?: unknown; object?: unknown };
      if (typeof name !== 'string' || !name) throw bad();
      if (level <= 1 || child === undefined || child === null) return { name };
      const nested = list(child, level - 1);
      return nested ? { name, entries: nested } : { name };
    });
  };
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw bad();
  const object = (raw as { object?: unknown }).object;
  return object === null || object === undefined ? null : list(object, depth);
}
export interface BlobRef {
  ref: string;
  path: string;
}

function parseJsonFile(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `Invalid JSON in repository file ${path}`);
  }
}

// The live file is ~2 MB: per-byte callbacks (Uint8Array.from(.., fn)) cost >100 ms of CPU, which
// the Workers free plan (10 ms) cannot afford. Use the native codecs where the runtime has them.
const nativeBase64 = Uint8Array as unknown as { fromBase64?(text: string): Uint8Array };

function decodeBase64(text: string): Uint8Array {
  if (nativeBase64.fromBase64) return nativeBase64.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?(): string }).toBase64;
  if (native) return native.call(bytes);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768) as never);
  }
  return btoa(binary);
}

/** The exact text every JSON file is committed as (pretty, trailing newline). */
export const blobContent = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Git's blob SHA-1 of `text` (what GitHub reports as a file's sha), computed without a request. */
export async function blobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeContent(value: unknown): string {
  return encodeBase64(new TextEncoder().encode(blobContent(value)));
}

// Schemas of the export routes' GraphQL read, built once per isolate (not per request).
const exportBlob = z.object({ object: z.union([blobFields, z.object({}).strict()]) }).nullable();
const exportsRepository = z.object({
  ref: z
    .object({
      target: z
        .object({ oid: shaSchema.shape.sha, tree: z.object({ oid: shaSchema.shape.sha }) })
        .passthrough(),
    })
    .nullable(),
});
const exportsDir = z
  .object({
    object: z.union([
      z.object({
        entries: z.array(z.object({ name: z.string(), object: z.unknown().optional() })),
      }),
      z.object({}).strict(),
    ]),
  })
  .nullable();
const exportsHistory = z.object({
  nodes: z.array(z.object({ committedDate: z.iso.datetime({ offset: true }) })),
});
// First parses build zod's internals: done once at isolate startup, not in a request's CPU.
exportsRepository.safeParse({
  ref: { target: { oid: '0'.repeat(40), tree: { oid: '0'.repeat(40) } } },
});
exportBlob.safeParse({ object: { oid: '0'.repeat(40), isTruncated: false, text: '{}' } });
exportsDir.safeParse({ object: { entries: [{ name: 'warm.json', object: {} }] } });
exportsHistory.safeParse({ nodes: [{ committedDate: '2026-01-01T00:00:00Z' }] });

/** One read of the data branch for the export routes (see `GitHub.exportsRead`). */
export interface ExportsSnapshot {
  head: string;
  tree: string;
  permissions: RepoFile;
  /** The project's config file, or null when it does not exist. */
  config: RepoFile | null;
  /** Committer date of the last commit that touched the config path, or null. */
  lastCommit: string | null;
  /** Every `exports/projects/*.json` file (name without `.json`) when asked for (`names`: null files). */
  projects: { id: string; file: RepoFile | null }[] | null;
}

export class GitHub {
  private token?: string;
  private spent = 0;
  readonly root: string;

  constructor(
    readonly env: Env,
    private readonly tokenPermissions: {
      contents?: 'read' | 'write';
      actions?: 'read' | 'write';
    } = { contents: 'write' },
  ) {
    this.root = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
  }

  /** Subrequests this operation may still make. */
  get remaining(): number {
    return subrequestLimit - this.spent;
  }

  /** Records `count` outgoing requests; refuses before the platform limit is reached. */
  spend(count = 1): void {
    if (this.spent + count > subrequestLimit) {
      throw new HttpError(
        503,
        'This operation needs too many upstream requests; retry it, or use a smaller selection',
      );
    }
    this.spent += count;
  }

  private async installationToken(): Promise<string> {
    if (this.token) return this.token;
    this.spend();
    const jwt = await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY);
    const response = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(this.env.GITHUB_INSTALLATION_ID)}/access_tokens`,
      {
        method: 'POST',
        headers: this.headers(jwt),
        body: JSON.stringify({
          repositories: [this.env.GITHUB_REPO],
          permissions: this.tokenPermissions,
        }),
      },
    );
    if (!response.ok)
      throw new HttpError(502, `GitHub App authentication failed (${response.status})`);
    this.token = z.object({ token: z.string() }).parse(await response.json()).token;
    return this.token;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'clarity-editor',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async request(path: string, method = 'GET', value?: unknown): Promise<Response> {
    const headers = this.headers(await this.installationToken());
    this.spend();
    const response = await fetch(`https://api.github.com${this.root}${path}`, {
      method,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    if (response.status === 403 || response.status === 429) {
      throw new HttpError(
        503,
        'GitHub refused the request (App permissions or rate limit); try again later',
      );
    }
    return response;
  }

  async result(path: string, method = 'GET', value?: unknown): Promise<unknown> {
    const response = await this.request(path, method, value);
    if (!response.ok) throw new HttpError(502, `GitHub request failed (${response.status})`);
    return response.json();
  }

  async head(branch = this.env.DATA_BRANCH): Promise<string> {
    return refSchema.parse(await this.result(`/git/ref/heads/${encodeURIComponent(branch)}`)).object
      .sha;
  }

  /** `missingFiles`: the query reads `Commit.file(path:)` fields, which may legitimately be absent. */
  private async graphql(
    query: string,
    variables: Record<string, string>,
    missingFiles = false,
  ): Promise<unknown> {
    const headers = this.headers(await this.installationToken());
    this.spend();
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (response.status === 403 || response.status === 429) {
      throw new HttpError(
        503,
        'GitHub refused the request (App permissions or rate limit); try again later',
      );
    }
    if (!response.ok) throw new HttpError(502, `GitHub batch read failed (${response.status})`);
    const result = graphqlSchema.parse(await response.json());
    const repository = result.data?.repository;
    if (
      !repository ||
      (result.errors?.length && !(missingFiles && onlyMissingFiles(result.errors, repository)))
    ) {
      throw new HttpError(502, 'GitHub batch read failed');
    }
    return repository;
  }

  /**
   * Reads many JSON files at specific commits with one subrequest per `blobsPerQuery` files
   * (GraphQL aliased `object(expression: "<sha>:<path>")` reads) instead of one or more per
   * file. Positional result; `null` for a missing file. Refs must be full commit SHAs and paths
   * plain repository paths, so an expression cannot name another ref or escape its path, and
   * they travel as GraphQL variables, never spliced into the query text.
   */
  async blobs(refs: readonly BlobRef[]): Promise<(RepoFile | null)[]> {
    for (const { ref, path } of refs) {
      if (
        !refPattern.test(ref) ||
        !pathPattern.test(path) ||
        path.includes('..') ||
        path.includes('//')
      ) {
        throw new HttpError(400, 'Invalid repository file reference');
      }
    }
    const result: (RepoFile | null)[] = [];
    for (let start = 0; start < refs.length; start += blobsPerQuery) {
      const chunk = refs.slice(start, start + blobsPerQuery);
      const declarations = chunk.map((_, index) => `$e${index}:String!`).join(',');
      const selections = chunk
        .map((_, index) => `o${index}:object(expression:$e${index}){...B}`)
        .join(' ');
      const query =
        `query($owner:String!,$name:String!,${declarations}){` +
        `repository(owner:$owner,name:$name){${selections}}} ` +
        'fragment B on Blob{oid isTruncated text}';
      const variables: Record<string, string> = {
        owner: this.env.GITHUB_OWNER,
        name: this.env.GITHUB_REPO,
      };
      chunk.forEach(({ ref, path }, index) => (variables[`e${index}`] = `${ref}:${path}`));
      const repository = z
        .record(z.string(), z.unknown())
        .parse(await this.graphql(query, variables));
      for (const [index, { ref, path }] of chunk.entries()) {
        const entry = blobEntry.parse(repository[`o${index}`]);
        if (entry === null) {
          result.push(null);
        } else if ('text' in entry && entry.text !== null && !entry.isTruncated) {
          result.push({ sha: entry.oid, value: parseJsonFile(entry.text, path) });
        } else {
          // Not a blob, or too large for GraphQL text: the contents API decides.
          result.push(await this.file(path, ref));
        }
      }
    }
    return result;
  }

  /** Several files at one commit; see `blobs`. */
  async files(paths: readonly string[], ref: string): Promise<(RepoFile | null)[]> {
    return this.blobs(paths.map((path) => ({ ref, path })));
  }

  /**
   * One head and its files, all selected through that Commit. No fallback reads: bounded.
   * `trees` adds names-only listings of directories at the same Commit (no blob text, no oids),
   * `depth` levels deep, in the SAME GraphQL subrequest; a missing directory lists as null.
   */
  async publishSnapshot(
    paths: readonly string[],
    oidOnly: readonly string[] = [],
    trees: readonly { path: string; depth: number }[] = [],
  ) {
    const invalid = (p: string) => !pathPattern.test(p) || p.includes('..') || p.includes('//');
    if (
      paths.length + trees.length > 41 ||
      paths.some(invalid) ||
      trees.some(
        ({ path, depth }) => invalid(path) || !Number.isInteger(depth) || depth < 1 || depth > 3,
      )
    )
      throw new HttpError(400, 'Invalid publish paths');
    const entries = (depth: number): string =>
      `entries{name${depth > 1 ? ` object{... on Tree{${entries(depth - 1)}}}` : ''}}`;
    const selections = [
      ...paths.map(
        (path, i) =>
          `o${i}:file(path:$p${i}){object{... on Blob{${oidOnly.includes(path) ? 'oid' : 'oid isTruncated text'}}}}`,
      ),
      ...trees.map(
        ({ depth }, i) => `t${i}:file(path:$t${i}){object{... on Tree{${entries(depth)}}}}`,
      ),
    ].join(' ');
    const variables: Record<string, string> = {
      owner: this.env.GITHUB_OWNER,
      name: this.env.GITHUB_REPO,
      branch: `refs/heads/${this.env.DATA_BRANCH}`,
    };
    paths.forEach((p, i) => (variables[`p${i}`] = p));
    trees.forEach(({ path }, i) => (variables[`t${i}`] = path));
    const declarations = [
      ...paths.map((_, i) => `$p${i}:String!`),
      ...trees.map((_, i) => `$t${i}:String!`),
    ].join(',');
    const repository = z
      .object({
        ref: z.object({
          target: z
            .object({
              oid: shaSchema.shape.sha,
              tree: z.object({ oid: shaSchema.shape.sha }),
            })
            .passthrough(),
        }),
      })
      .parse(
        await this.graphql(
          `query($owner:String!,$name:String!,$branch:String!,${declarations}){repository(owner:$owner,name:$name){ref(qualifiedName:$branch){target{... on Commit{oid tree{oid} ${selections}}}}}}`,
          variables,
          true,
        ),
      );
    const target = repository.ref.target;
    const files = paths.map((path, i): RepoFile | null => {
      if (oidOnly.includes(path)) {
        const entry = z
          .object({ object: z.object({ oid: shaSchema.shape.sha }) })
          .nullable()
          .parse(target[`o${i}`]);
        return entry ? { sha: entry.object.oid, value: undefined } : null;
      }
      const entry = z.object({ object: blobFields }).nullable().parse(target[`o${i}`]);
      if (!entry) return null;
      if (entry.object.isTruncated || entry.object.text === null)
        throw new HttpError(502, 'Publish metadata is too large or unreadable');
      return { sha: entry.object.oid, value: parseJsonFile(entry.object.text, path) };
    });
    const listed = trees.map(({ depth }, i) => treeNodes(target[`t${i}`], depth));
    return { head: target.oid, tree: target.tree.oid, files, trees: listed };
  }

  /**
   * The export routes' single read (spec section 4): branch head and root tree, permissions,
   * one project's config blob (text and SHA) with the date of the last commit that touched it,
   * and optionally every project file, all from one Commit in ONE GraphQL subrequest. Paths are
   * fixed by the caller (validated ids only) and travel as variables.
   */
  async exportsRead(
    projectPath: string | null,
    list: false | 'names' | 'blobs',
  ): Promise<ExportsSnapshot> {
    const blob = '{object{... on Blob{oid isTruncated text}}}';
    const variables: Record<string, string> = {
      owner: this.env.GITHUB_OWNER,
      name: this.env.GITHUB_REPO,
      branch: `refs/heads/${this.env.DATA_BRANCH}`,
      perm: 'config/permissions.json',
    };
    const declarations = ['$owner:String!', '$name:String!', '$branch:String!', '$perm:String!'];
    let selections = `perm:file(path:$perm)${blob}`;
    if (projectPath !== null) {
      if (!/^exports\/projects\/[a-z][a-z0-9-]{1,31}\.json$/.test(projectPath))
        throw new HttpError(400, 'Invalid project path');
      variables.config = projectPath;
      declarations.push('$config:String!');
      selections +=
        ` config:file(path:$config)${blob}` +
        ' last:history(first:1,path:$config){nodes{committedDate}}';
    }
    if (list) {
      variables.dir = 'exports/projects';
      declarations.push('$dir:String!');
      // `names` (a count and existence check) skips every blob's text.
      const entry = list === 'blobs' ? 'name object{... on Blob{oid isTruncated text}}' : 'name';
      selections += ` dir:file(path:$dir){object{... on Tree{entries{${entry}}}}}`;
    }
    const repository = exportsRepository.parse(
      await this.graphql(
        `query(${declarations.join(',')}){repository(owner:$owner,name:$name){ref(qualifiedName:$branch){target{... on Commit{oid tree{oid} ${selections}}}}}}`,
        variables,
        true,
      ),
    );
    if (!repository.ref) throw new HttpError(502, 'Data branch is missing');
    const target = repository.ref.target;
    const read = (raw: unknown, path: string): RepoFile | null => {
      const entry = exportBlob.parse(raw);
      if (!entry) return null;
      if (!('oid' in entry.object) || entry.object.isTruncated || entry.object.text === null)
        throw new HttpError(502, `Repository file is not a readable JSON blob: ${path}`);
      return { sha: entry.object.oid, value: parseJsonFile(entry.object.text, path) };
    };
    const permissions = read(target.perm, 'config/permissions.json');
    if (!permissions)
      throw new HttpError(502, 'Required repository file is missing: config/permissions.json');
    let projects: ExportsSnapshot['projects'] = null;
    if (list) {
      const dir = exportsDir.parse(target.dir);
      projects = [];
      for (const entry of dir && 'entries' in dir.object ? dir.object.entries : []) {
        const match = /^([a-z][a-z0-9-]{1,31})\.json$/.exec(entry.name);
        // Anything else in the folder is not a project file: never listed, never written.
        if (!match) continue;
        if (list === 'names') {
          projects.push({ id: match[1]!, file: null });
          continue;
        }
        const file = read({ object: entry.object ?? {} }, `exports/projects/${entry.name}`);
        if (file) projects.push({ id: match[1]!, file });
      }
      projects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return {
      head: target.oid,
      tree: target.tree.oid,
      permissions,
      config: projectPath === null ? null : read(target.config, projectPath),
      lastCommit:
        projectPath === null
          ? null
          : (exportsHistory.parse(target.last).nodes[0]?.committedDate ?? null),
      projects,
    };
  }

  /**
   * A GitHub account's numeric id and canonical login, looked up once when a maintainer adds a
   * partner by login (spec section 4). Organisations and bots are refused: a partner is a person.
   */
  async account(login: string): Promise<{ id: number; login: string }> {
    const headers = this.headers(await this.installationToken());
    this.spend();
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers,
    });
    if (response.status === 404) throw new HttpError(404, `GitHub account not found: ${login}`);
    if (response.status === 403 || response.status === 429)
      throw new HttpError(503, 'GitHub refused the account lookup; try again later');
    if (!response.ok) throw new HttpError(502, `GitHub account lookup failed (${response.status})`);
    const account = z
      .object({ id: z.number().int().positive(), login: z.string().min(1), type: z.string() })
      .parse(await response.json());
    if (account.type !== 'User')
      throw new HttpError(400, `${account.login} is not a personal GitHub account`);
    return { id: account.id, login: account.login };
  }

  /** Three writes, sole parent H. No rebase: a concurrent head move must reject this commit. */
  async createPublishRequest(
    head: string,
    baseTree: string,
    path: string,
    value: unknown,
    user: Identity,
  ) {
    const tree = shaSchema.parse(
      await this.result('/git/trees', 'POST', {
        base_tree: baseTree,
        tree: [{ path, mode: '100644', type: 'blob', content: JSON.stringify(value) + '\n' }],
      }),
    );
    const commit = shaSchema.parse(
      await this.result('/git/commits', 'POST', {
        tree: tree.sha,
        parents: [head],
        message: `Request publish by ${user.login}`,
        ...this.credits(user),
      }),
    );
    const response = await this.request(
      `/git/refs/heads/${encodeURIComponent(this.env.DATA_BRANCH)}`,
      'PATCH',
      {
        sha: commit.sha,
        force: false,
      },
    );
    if (!response.ok) throw new HttpError(503, 'Publish create needs reconciliation');
  }

  async kickPublish(opId: string) {
    const nonce = [...crypto.getRandomValues(new Uint32Array(2))].join('');
    await this.result(`/contents/publish/kicks/${opId}-${nonce}.json`, 'PUT', {
      branch: this.env.DATA_BRANCH,
      message: `Kick publish ${opId}`,
      content: encodeContent({ opId }),
    });
  }

  async file(path: string, ref: string): Promise<RepoFile | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const response = await this.request(`/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new HttpError(502, `GitHub file read failed (${response.status})`);
    const metadata = fileSchema.parse(await response.json());
    const blob =
      metadata.encoding === 'base64'
        ? metadata
        : fileSchema.parse(await this.result(`/git/blobs/${metadata.sha}`));
    if (blob.encoding !== 'base64') throw new HttpError(502, 'Unsupported GitHub content encoding');
    let text: string;
    try {
      // atob and fromBase64 both ignore the line breaks GitHub puts into its base64.
      text = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(blob.content));
    } catch {
      throw new HttpError(502, `Invalid JSON in repository file ${path}`);
    }
    return { sha: metadata.sha, value: parseJsonFile(text, path) };
  }

  async requiredFile(path: string, ref: string): Promise<RepoFile> {
    const file = await this.file(path, ref);
    if (!file) throw new HttpError(502, `Required repository file is missing: ${path}`);
    return file;
  }

  private credits(user: Identity) {
    const bot = `${this.env.GITHUB_APP_SLUG}[bot]`;
    return {
      author: { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` },
      committer: { name: bot, email: `${bot}@users.noreply.github.com` },
    };
  }

  /** Bot as author and committer, with an explicit date: the commit names no user. */
  private botCredits(date: string) {
    const bot = `${this.env.GITHUB_APP_SLUG}[bot]`;
    const identity = { name: bot, email: `${bot}@users.noreply.github.com`, date };
    return { author: identity, committer: identity };
  }

  /** Branch head, or null when the branch does not exist yet. */
  async headOrNull(branch: string): Promise<string | null> {
    const response = await this.request(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new HttpError(502, `GitHub ref read failed (${response.status})`);
    return refSchema.parse(await response.json()).object.sha;
  }

  private async write(
    branch: string,
    head: string | null,
    files: Record<string, unknown>,
    message: string,
    credits: object,
    { baseTree, deletions = [] }: { baseTree?: string; deletions?: readonly string[] } = {},
  ): Promise<string> {
    const base =
      baseTree ??
      (head ? commitSchema.parse(await this.result(`/git/commits/${head}`)).tree.sha : undefined);
    const tree = shaSchema.parse(
      await this.result('/git/trees', 'POST', {
        ...(base ? { base_tree: base } : {}),
        tree: [
          ...Object.entries(files).map(([path, value]) => ({
            path,
            mode: '100644',
            type: 'blob',
            content: blobContent(value),
          })),
          // `sha: null` removes the path from the base tree.
          ...deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
        ],
      }),
    );
    const commit = shaSchema.parse(
      await this.result('/git/commits', 'POST', {
        message,
        tree: tree.sha,
        parents: head ? [head] : [],
        ...credits,
      }),
    );
    const update = head
      ? await this.request(`/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', {
          sha: commit.sha,
          force: false,
        })
      : await this.request('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    if (update.status === 409 || update.status === 422) throw new RefRace(`${branch} moved`);
    if (!update.ok) throw new HttpError(502, `GitHub ref update failed (${update.status})`);
    return commit.sha;
  }

  /**
   * Data-branch commit authored by `user`, committed by the app, sole parent `head` (ref CAS,
   * `force: false`; RefRace when the branch moved). `baseTree` skips reading `head`'s tree when
   * the caller already has it; `deletions` removes paths.
   */
  async commit(
    head: string,
    files: Record<string, unknown>,
    message: string,
    user: Identity,
    options: { baseTree?: string; deletions?: readonly string[] } = {},
  ): Promise<string> {
    return this.write(this.env.DATA_BRANCH, head, files, message, this.credits(user), options);
  }

  /**
   * Commit authored and committed by the bot on `branch`, which is created as a new root
   * history when `head` is null. Used by synced settings, never by tooltip data.
   */
  async commitAsBot(
    branch: string,
    head: string | null,
    files: Record<string, unknown>,
    message: string,
    date: string,
  ): Promise<string> {
    return this.write(branch, head, files, message, this.botCredits(date));
  }

  async putLive(sha: string, value: unknown, user: Identity): Promise<string> {
    const response = await this.request('/contents/liveDescriptions.json', 'PUT', {
      message: `Push selected tooltips live by ${user.login}`,
      branch: this.env.LIVE_BRANCH,
      sha,
      content: encodeContent(value),
      ...this.credits(user),
    });
    if (response.status === 409 || response.status === 422) throw new RefRace('Live branch moved');
    if (!response.ok) throw new HttpError(502, `GitHub live write failed (${response.status})`);
    return z.object({ commit: shaSchema }).parse(await response.json()).commit.sha;
  }
}
