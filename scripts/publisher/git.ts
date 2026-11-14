import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maxBuffer } from './childProcess.mjs';

export class RefRace extends Error {}
export type Tree = Record<string, string>;
export interface CommitCredits {
  author: { name: string; email: string };
  committer: { name: string; email: string };
}
export const appCredits: CommitCredits = {
  author: {
    name: 'clarity-editor-backend[bot]',
    email: 'clarity-editor-backend[bot]@users.noreply.github.com',
  },
  committer: {
    name: 'clarity-editor-backend[bot]',
    email: 'clarity-editor-backend[bot]@users.noreply.github.com',
  },
};
export function requesterCredits(user: { id: number; login: string }): CommitCredits {
  if (
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)
  )
    throw new Error('Invalid publisher requester identity');
  return {
    author: { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` },
    committer: appCredits.committer,
  };
}
export interface Repository {
  head(ref: string): string | undefined;
  tree(commit: string): Tree;
  blob(oid: string): string;
  writeBlob(bytes: string): string;
  commit(parent: string | undefined, tree: Tree, message: string, credits?: CommitCredits): string;
  cas(ref: string, old: string | undefined, next: string | undefined): void;
  ancestor(a: string, b: string): boolean;
  history(ref: string): string[];
  additions(head: string, path: string): { commit: string; path: string }[];
}

/** Disposable bare object store; the simulator updates only local refs, RemoteRepository supplies transport. */
export class LocalRepository implements Repository {
  readonly path: string;
  protected commandTimeout = 120_000;
  protected preserveModes = false;
  private trees = new Map<string, Tree>();
  private blobs = new Map<string, string>();
  constructor(path: string) {
    this.path = realpathSync(resolve(path));
    if (this.git(['rev-parse', '--is-bare-repository']).trim() !== 'true')
      throw new Error('Bare simulator required');
    if (this.git(['config', '--get', 'publisher.simulator']).trim() !== 'true')
      throw new Error('Simulator opt-in required');
    if (this.git(['remote']).trim()) throw new Error('Simulator must have no remotes');
  }
  git(args: string[], input?: string, extraEnv = {}): string {
    return execFileSync('git', ['--git-dir', this.path, ...args], {
      input,
      timeout: this.commandTimeout,
      maxBuffer,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Publisher simulator',
        GIT_AUTHOR_EMAIL: 'publisher@invalid',
        GIT_COMMITTER_NAME: 'Publisher simulator',
        GIT_COMMITTER_EMAIL: 'publisher@invalid',
        ...extraEnv,
      },
    });
  }
  head(ref: string) {
    if (!/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(ref)) throw new Error('Invalid branch ref');
    try {
      return this.git(['rev-parse', '--verify', ref]).trim();
    } catch {
      return undefined;
    }
  }
  tree(commit: string): Tree {
    const cached = this.trees.get(commit);
    if (cached) return { ...cached };
    const tree = Object.fromEntries(
      this.git(['ls-tree', '-rz', '--full-tree', commit])
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split('\t');
          const [mode, type, oid] = meta.split(' ');
          if (!this.preserveModes && (mode !== '100644' || type !== 'blob'))
            throw new Error('Only plain blob trees supported');
          return [path, oid];
        }),
    );
    this.trees.set(commit, tree);
    return { ...tree };
  }
  blob(oid: string) {
    if (!this.blobs.has(oid)) this.blobs.set(oid, this.git(['cat-file', 'blob', oid]));
    return this.blobs.get(oid)!;
  }
  writeBlob(bytes: string) {
    const oid = this.git(['hash-object', '-w', '--stdin'], bytes).trim();
    this.blobs.set(oid, bytes);
    return oid;
  }
  protected requireCredits = false;
  commit(parent: string | undefined, tree: Tree, message: string, credits?: CommitCredits) {
    if (!credits && this.requireCredits) throw new Error('Remote commits require explicit credits');
    if (credits)
      for (const identity of [credits.author, credits.committer]) {
        if (!identity.name || !identity.email || /[<>\r\n\0]/.test(identity.name + identity.email))
          throw new Error('Invalid commit credits');
      }
    const temp = mkdtempSync(join(tmpdir(), 'publisher-index-'));
    try {
      const modes = new Map<string, string>();
      if (this.preserveModes && parent)
        for (const line of this.git(['ls-tree', '-rz', '--full-tree', parent])
          .split('\0')
          .filter(Boolean)) {
          const tab = line.indexOf('\t');
          modes.set(line.slice(tab + 1), line.slice(0, 6));
        }
      const env = { GIT_INDEX_FILE: join(temp, 'index') };
      this.git(['read-tree', '--empty'], undefined, env);
      this.git(
        ['update-index', '-z', '--index-info'],
        Object.entries(tree)
          .sort()
          .map(([p, oid]) => {
            if (/[\0\n\t]/.test(p)) throw new Error('Invalid tree path');
            return `${modes.get(p) ?? '100644'} ${oid}\t${p}\0`;
          })
          .join(''),
        env,
      );
      const root = this.git(['write-tree'], undefined, env).trim();
      const commit = this.git(
        ['commit-tree', root, ...(parent ? ['-p', parent] : [])],
        message,
        credits
          ? {
              GIT_AUTHOR_NAME: credits.author.name,
              GIT_AUTHOR_EMAIL: credits.author.email,
              GIT_COMMITTER_NAME: credits.committer.name,
              GIT_COMMITTER_EMAIL: credits.committer.email,
            }
          : {},
      ).trim();
      this.trees.set(commit, { ...tree });
      return commit;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  cas(ref: string, old: string | undefined, next: string | undefined) {
    if (!/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(ref)) throw new Error('Invalid branch ref');
    try {
      this.git(['update-ref', ref, next ?? '0'.repeat(40), old ?? '0'.repeat(40)]);
    } catch {
      throw new RefRace(`Ref raced: ${ref}`);
    }
  }
  ancestor(a: string, b: string) {
    try {
      this.git(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }
  history(ref: string) {
    return this.git(['rev-list', '--first-parent', '--reverse', ref])
      .trim()
      .split('\n')
      .filter(Boolean);
  }
  additions(head: string, path: string) {
    const lines = this.git([
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--diff-filter=A',
      '--no-renames',
      '--root',
      '--reverse',
      '--format=%H',
      '--name-only',
      head,
      '--',
      path,
    ]).split('\n');
    let commit = '';
    const entries: { commit: string; path: string }[] = [];
    for (const line of lines) {
      if (/^[0-9a-f]{40}$/.test(line)) commit = line;
      else if (line) entries.push({ commit, path: line });
    }
    return entries;
  }
}
