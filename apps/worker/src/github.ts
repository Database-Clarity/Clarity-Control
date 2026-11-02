import { z } from 'zod';
import { appJwt } from './crypto.js';
import { HttpError } from './http.js';
import type { Env, Identity } from './types.js';

const shaSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const fileSchema = shaSchema.extend({ content: z.string(), encoding: z.string() });
const refSchema = z.object({ object: shaSchema });
const commitSchema = z.object({ tree: shaSchema });

export class RefRace extends Error {}

function encodeContent(value: unknown): string {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export class GitHub {
  private token?: string;
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

  private async installationToken(): Promise<string> {
    if (this.token) return this.token;
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
    const response = await fetch(`https://api.github.com${this.root}${path}`, {
      method,
      headers: this.headers(await this.installationToken()),
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

  async file(path: string, ref: string): Promise<{ sha: string; value: unknown } | null> {
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
    let value: unknown;
    try {
      const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), (char) =>
        char.charCodeAt(0),
      );
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new HttpError(502, `Invalid JSON in repository file ${path}`);
    }
    return { sha: metadata.sha, value };
  }

  async requiredFile(path: string, ref: string): Promise<{ sha: string; value: unknown }> {
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
