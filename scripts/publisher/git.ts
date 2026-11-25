import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maxBuffer } from './childProcess.mjs';

export class RefRace extends Error {}
export type Tree = Record<string, string>;
const emptyTreeOid = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
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
  commitParents(commit: string): string[];
  tree(commit: string): Tree;
  /** Entry modes, including explicit empty trees that a flattened tree cannot represent. */
  treeModes?(commit: string): Record<string, string>;
  blob(oid: string): string;
  writeBlob(bytes: string): string;
  commit(parent: string | undefined, tree: Tree, message: string, credits?: CommitCredits): string;
  cas(ref: string, old: string | undefined, next: string | undefined): void;
  /** Required by globals releases: source RECORD and live change are one transaction. */
  casMany?(updates: { ref: string; old: string; next: string }[]): void;
  ancestor(a: string, b: string): boolean;
  history(ref: string): string[];
  additions(head: string, path: string): { commit: string; path: string }[];
}

/** Per-document files: a publisher step that reads one reads (nearly) all of them. */
const bulkPath =
  /^(?:(?:tooltips|live\/tooltips|globals|schedule\/batches\/[^/]+\/tooltips)\/|live\/(?:pushed|translation-roots)\.json$)/;

/** Disposable bare object store; the simulator updates only local refs, RemoteRepository supplies transport. */
export class LocalRepository implements Repository {
  readonly path: string;
  protected commandTimeout = 120_000;
  protected preserveModes = false;
  private trees = new Map<string, Tree>();
  private blobs = new Map<string, string>();
  /** A bulk document's object ID to every bulk object ID of a tree that holds it. */
  private bulk = new Map<string, string[]>();
  /** Blobs not yet in the object store; commit() imports them all with one Git process. */
  private unwritten = new Map<string, Buffer>();
  constructor(path: string) {
    this.path = realpathSync(resolve(path));
    if (this.git(['rev-parse', '--is-bare-repository']).trim() !== 'true')
      throw new Error('Bare simulator required');
    if (this.git(['config', '--get', 'publisher.simulator']).trim() !== 'true')
      throw new Error('Simulator opt-in required');
    if (this.git(['remote']).trim()) throw new Error('Simulator must have no remotes');
  }
  git(args: string[], input?: string, extraEnv = {}): string {
    return this.gitBytes(args, input, extraEnv).toString();
  }
  protected gitBytes(args: string[], input?: string | Buffer, extraEnv = {}): Buffer {
    return execFileSync('git', ['--git-dir', this.path, ...args], {
      input,
      timeout: this.commandTimeout,
      maxBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Only remoteGit authenticates, through its own configuration variables.
        GITHUB_TOKEN: undefined,
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
          const tab = line.indexOf('\t');
          const [mode, type, oid] = line.slice(0, tab).split(' ');
          if (!this.preserveModes && (mode !== '100644' || type !== 'blob'))
            throw new Error('Only plain blob trees supported');
          return [line.slice(tab + 1), oid];
        }),
    );
    this.trees.set(commit, tree);
    const bulk = Object.keys(tree)
      .filter((path) => bulkPath.test(path))
      .map((path) => tree[path]);
    for (const oid of bulk) this.bulk.set(oid, bulk);
    return { ...tree };
  }
  /**
   * Load bulk documents through one Git process instead of one each; all or nothing. An object
   * that is missing or not a blob stays uncached, so blob() still fails on it when it is used.
   */
  private readBulk(bulk: string[]) {
    const oids = [...new Set(bulk)].filter((oid) => !this.blobs.has(oid));
    const output = this.gitBytes(['cat-file', '--batch'], oids.map((oid) => `${oid}\n`).join(''));
    const read = new Map<string, string>();
    let at = 0;
    for (const oid of oids) {
      const end = output.indexOf('\n', at);
      const header = end < 0 ? '' : output.toString('latin1', at, end);
      at = end + 1;
      if (header === `${oid} missing`) continue;
      const [, named, type, size] = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(header) ?? [];
      const stop = at + Number(size);
      if (named !== oid || output[stop] !== 10) throw new Error('Unexpected Git batch output');
      if (type === 'blob') read.set(oid, output.toString('utf8', at, stop));
      at = stop + 1;
    }
    if (at !== output.length) throw new Error('Unexpected Git batch output');
    for (const [oid, bytes] of read) this.blobs.set(oid, bytes);
  }
  treeModes(commit: string): Record<string, string> {
    return Object.fromEntries(
      this.git(['ls-tree', '-rtz', '--full-tree', commit])
        .split('\0')
        .filter(Boolean)
        .flatMap((line) => {
          const tab = line.indexOf('\t');
          const [mode, type, oid] = line.slice(0, tab).split(' ');
          return type === 'tree' && oid !== emptyTreeOid ? [] : [[line.slice(tab + 1), mode]];
        }),
    );
  }
  blob(oid: string) {
    if (!this.blobs.has(oid) && this.bulk.has(oid)) this.readBulk(this.bulk.get(oid)!);
    if (!this.blobs.has(oid)) this.blobs.set(oid, this.git(['cat-file', 'blob', oid]));
    return this.blobs.get(oid)!;
  }
  writeBlob(bytes: string) {
    const buffer = Buffer.from(bytes);
    const oid = createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
    // A known blob is in the object store, or already waits for its import.
    if (!this.blobs.has(oid)) this.unwritten.set(oid, buffer);
    this.blobs.set(oid, bytes);
    return oid;
  }
  /** Import the waiting blobs (no refs). Git itself must name every one of them. */
  private writeBlobs() {
    if (!this.unwritten.size) return;
    const stream = [...this.unwritten.values()].flatMap((buffer, index) => [
      Buffer.from(`blob\nmark :${index + 1}\ndata ${buffer.length}\n`),
      buffer,
      Buffer.from(`\nget-mark :${index + 1}\n`),
    ]);
    const stored = this.gitBytes(
      ['fast-import', '--quiet', '--done'],
      Buffer.concat([...stream, Buffer.from('done\n')]),
    );
    if (stored.toString() !== [...this.unwritten.keys()].map((oid) => `${oid}\n`).join(''))
      throw new Error('Unexpected Git import output');
    this.unwritten.clear();
  }
  protected requireCredits = false;
  commit(parent: string | undefined, tree: Tree, message: string, credits?: CommitCredits) {
    if (!credits && this.requireCredits) throw new Error('Remote commits require explicit credits');
    if (credits)
      for (const identity of [credits.author, credits.committer]) {
        if (!identity.name || !identity.email || /[<>\r\n\0]/.test(identity.name + identity.email))
          throw new Error('Invalid commit credits');
      }
    this.writeBlobs();
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
  casMany(updates: { ref: string; old: string; next: string }[]) {
    if (
      updates.length !== 2 ||
      new Set(updates.map((update) => update.ref)).size !== 2 ||
      updates.some(
        ({ ref, old, next }) =>
          !/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(ref) ||
          !/^[a-f0-9]{40}$/.test(old) ||
          !/^[a-f0-9]{40}$/.test(next),
      )
    )
      throw new Error('Invalid atomic publication');
    try {
      this.git(
        ['update-ref', '--stdin'],
        `start\n${updates.map(({ ref, old, next }) => `update ${ref} ${next} ${old}\n`).join('')}prepare\ncommit\n`,
      );
    } catch {
      throw new RefRace('Atomic publication raced');
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
  commitParents(commit: string) {
    return [
      ...this.git(['cat-file', 'commit', commit])
        .split('\n\n', 1)[0]
        .matchAll(/^parent ([a-f0-9]{40})$/gm),
    ].map(([, parent]) => parent);
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
