import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class RefRace extends Error {}
export type Tree = Record<string, string>;
export interface Repository {
  head(ref: string): string | undefined;
  tree(commit: string): Tree;
  blob(oid: string): string;
  writeBlob(bytes: string): string;
  commit(parent: string | undefined, tree: Tree, message: string): string;
  cas(ref: string, old: string | undefined, next: string | undefined): void;
  ancestor(a: string, b: string): boolean;
  history(ref: string): string[];
}

/** Only a disposable local bare repository can be mutated. No network transport exists in P1-A. */
export class LocalRepository implements Repository {
  readonly path: string;
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
          if (mode !== '100644' || type !== 'blob')
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
  commit(parent: string | undefined, tree: Tree, message: string) {
    const temp = mkdtempSync(join(tmpdir(), 'publisher-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(temp, 'index') };
      this.git(['read-tree', '--empty'], undefined, env);
      this.git(
        ['update-index', '-z', '--index-info'],
        Object.entries(tree)
          .sort()
          .map(([p, oid]) => {
            if (/[\0\n\t]/.test(p)) throw new Error('Invalid tree path');
            return `100644 ${oid}\t${p}\0`;
          })
          .join(''),
        env,
      );
      const root = this.git(['write-tree'], undefined, env).trim();
      const commit = this.git(
        ['commit-tree', root, ...(parent ? ['-p', parent] : [])],
        message,
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
}
