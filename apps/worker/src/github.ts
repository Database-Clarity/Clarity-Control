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

  async commit(
    head: string,
    files: Record<string, unknown>,
    message: string,
    user: Identity,
  ): Promise<string> {
    const parent = commitSchema.parse(await this.result(`/git/commits/${head}`));
    const tree = shaSchema.parse(
      await this.result('/git/trees', 'POST', {
        base_tree: parent.tree.sha,
        tree: Object.entries(files).map(([path, value]) => ({
          path,
          mode: '100644',
          type: 'blob',
          content: `${JSON.stringify(value, null, 2)}\n`,
        })),
      }),
    );
    const commit = shaSchema.parse(
      await this.result('/git/commits', 'POST', {
        message,
        tree: tree.sha,
        parents: [head],
        ...this.credits(user),
      }),
    );
    const update = await this.request(
      `/git/refs/heads/${encodeURIComponent(this.env.DATA_BRANCH)}`,
      'PATCH',
      { sha: commit.sha, force: false },
    );
    if (update.status === 409 || update.status === 422) throw new RefRace('Data branch moved');
    if (!update.ok) throw new HttpError(502, `GitHub ref update failed (${update.status})`);
    return commit.sha;
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
