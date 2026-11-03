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
const pathPattern = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
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

export interface RepoFile {
  sha: string;
  value: unknown;
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

function encodeContent(value: unknown): string {
  return encodeBase64(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
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

  private async graphql(query: string, variables: Record<string, string>): Promise<unknown> {
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
    if (result.errors?.length || !result.data?.repository) {
      throw new HttpError(502, 'GitHub batch read failed');
    }
    return result.data.repository;
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
  ): Promise<string> {
    const parent = head ? commitSchema.parse(await this.result(`/git/commits/${head}`)) : null;
    const tree = shaSchema.parse(
      await this.result('/git/trees', 'POST', {
        ...(parent ? { base_tree: parent.tree.sha } : {}),
        tree: Object.entries(files).map(([path, value]) => ({
          path,
          mode: '100644',
          type: 'blob',
          content: `${JSON.stringify(value, null, 2)}
`,
        })),
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

  async commit(
    head: string,
    files: Record<string, unknown>,
    message: string,
    user: Identity,
  ): Promise<string> {
    return this.write(this.env.DATA_BRANCH, head, files, message, this.credits(user));
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
