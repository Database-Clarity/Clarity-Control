// Node helpers shared by build-site and the legacy job (spec section 3). Git runs with an argument
// list, never through a shell, so no value read from a config or a commit can become a command.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Runs git in `cwd` and returns stdout (raw bytes). Throws with git's stderr on failure. */
export function gitBytes(cwd: string, args: readonly string[], input?: Uint8Array): Buffer {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

export const git = (cwd: string, args: readonly string[], input?: Uint8Array) =>
  gitBytes(cwd, args, input).toString('utf8').trim();

/** `git show <commit>:<path>` as bytes, or undefined when the path does not exist there. */
export function gitShow(cwd: string, commit: string, path: string): Buffer | undefined {
  if (!isSha(commit)) throw new Error(`Not a commit id: ${commit}`);
  try {
    gitBytes(cwd, ['cat-file', '-e', `${commit}:${path}`]);
  } catch {
    return undefined;
  }
  return gitBytes(cwd, ['cat-file', 'blob', `${commit}:${path}`]);
}

/** Makes sure `commit` is present in a (possibly shallow or partial) clone. */
export function ensureCommit(cwd: string, commit: string) {
  if (!isSha(commit)) throw new Error(`Not a commit id: ${commit}`);
  try {
    gitBytes(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    gitBytes(cwd, ['fetch', '--no-tags', '--quiet', 'origin', commit]);
  }
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    gitBytes(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export function writeFile(path: string, bytes: Uint8Array | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export const readJson = <T = unknown>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** `--name value` command-line options; every value is a plain string (paths, ids). */
export function parseArgs(argv: readonly string[]): {
  command: string | undefined;
  options: Record<string, string>;
} {
  const options: Record<string, string> = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) options[arg.slice(2)] = 'true';
      else {
        options[arg.slice(2)] = value;
        index += 1;
      }
    } else if (command === undefined) command = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { command, options };
}

export function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value || value === 'true') throw new Error(`--${name} is required`);
  return value;
}

/** A positive integer option (milliseconds, counts), or the default. */
export function intOption(options: Record<string, string>, name: string, fallback: number) {
  const value = options[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} must be an integer`);
  return number;
}

/** Bytes of a URL: `file:` (dry-run harness) or http(s) with every cache bypassed. */
export async function fetchBytes(url: string, tries = 3): Promise<Uint8Array> {
  if (url.startsWith('file:')) return readFileSync(new URL(url));
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Appends Markdown to the Actions step summary when there is one (never through a shell). */
export function stepSummary(markdown: string) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) writeFileSync(path, markdown + '\n', { flag: 'a' });
}
