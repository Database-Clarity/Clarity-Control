import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { maxBuffer } from '../publisher/childProcess.mjs';

export const oidPattern = /^[0-9a-f]{40}$/;
const emptyOid = '0'.repeat(40);
export const branchPattern = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

// Ignore inherited Git config, credential helpers, proxy headers, hooks, and repo overrides.
// The only network-enabled invocation is the initial fetch from a fixed HTTPS URL.
export function gitEnvironment(directory, download = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|PATHEXT)$/i.test(key),
    ),
  );
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: download ? 'https' : '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_AUTHOR_NAME: 'Clarity local development',
    GIT_AUTHOR_EMAIL: 'dev-roles@invalid',
    GIT_COMMITTER_NAME: 'Clarity local development',
    GIT_COMMITTER_EMAIL: 'dev-roles@invalid',
  };
}

const run = promisify(execFile);
export async function downloadRepo(directory, repo, refs, shallowRefs = []) {
  const env = gitEnvironment(directory, true);
  await run('git', ['init', '--bare', '--template=', directory], {
    env,
    cwd: directory,
    windowsHide: true,
  });
  // Capture the companion branches first so a just-published bundle cannot
  // point ahead of editor-data. Fetch editor-data with its full history.
  for (const [list, extra] of [
    [shallowRefs, ['--depth=1']],
    [refs, []],
  ]) {
    if (!list.length) continue;
    await run(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        'http.extraHeader=',
        '-c',
        'http.followRedirects=false',
        '--git-dir',
        directory,
        'fetch',
        '--no-tags',
        '--no-auto-maintenance',
        ...extra,
        `https://github.com/${repo}.git`,
        ...list,
      ],
      { env, cwd: directory, timeout: 180_000, maxBuffer, windowsHide: true },
    );
  }
  return new SandboxGit(directory);
}

export class SandboxGit {
  constructor(directory) {
    this.directory = directory;
    this.env = gitEnvironment(directory);
  }

  git(args, input, env = {}) {
    return execFileSync('git', ['--git-dir', this.directory, ...args], {
      cwd: this.directory,
      input,
      env: { ...this.env, ...env },
      timeout: 120_000,
      maxBuffer,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  text(args, input, env) {
    return this.git(args, input, env).toString();
  }

  resolve(ref) {
    if (typeof ref !== 'string') return undefined;
    if (!oidPattern.test(ref)) {
      const branch = ref.replace(/^refs\/heads\//, '');
      if (!branchPattern.test(branch)) return undefined;
      ref = `refs/heads/${branch}`;
    }
    try {
      return this.text([
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ]).trim();
    } catch (error) {
      if (error.status === 1) return undefined;
      throw error;
    }
  }

  treeEntries(tree, recursive = false, path) {
    return this.text([
      'ls-tree',
      '-z',
      ...(recursive ? ['-rt'] : []),
      tree,
      '--',
      ...(path ? [path] : []),
    ])
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf('\t');
        const [mode, type, oid] = entry.slice(0, tab).split(' ');
        return { mode, type, oid, name: entry.slice(tab + 1) };
      });
  }

  blob(oid) {
    return this.git(['cat-file', 'blob', oid]);
  }

  // One Git process for a whole GraphQL batch (or the publisher's tooltip catalogue).
  objects(oids) {
    const ids = [...new Set(oids)];
    if (!ids.length) return new Map();
    if (!ids.every((oid) => oidPattern.test(oid))) throw new Error('Invalid object ID');
    const bytes = this.git(['cat-file', '--batch'], ids.join('\n') + '\n');
    let start = 0;
    const objects = new Map();
    for (const id of ids) {
      const end = bytes.indexOf(10, start);
      const [oid, type, size] = bytes.subarray(start, end).toString().split(' ');
      start = end + 1;
      if (type === 'missing') continue;
      objects.set(id, { oid, type, bytes: bytes.subarray(start, start + Number(size)) });
      start += Number(size) + 1;
    }
    return objects;
  }

  writeBlob(bytes) {
    return this.text(['hash-object', '-w', '--stdin'], bytes).trim();
  }

  writeTree(base, entries) {
    const env = { GIT_INDEX_FILE: join(this.directory, 'sandbox-api.index') };
    this.git(['read-tree', base ?? '--empty'], undefined, env);
    this.git(
      ['update-index', '-z', '--index-info'],
      entries
        .map(({ mode, oid, path }) => `${oid ? mode : '0'} ${oid ?? emptyOid}\t${path}\0`)
        .join(''),
      env,
    );
    return this.text(['write-tree'], undefined, env).trim();
  }

  commit(tree, parents, message, credits = {}) {
    const env = {};
    for (const role of ['author', 'committer']) {
      if (!credits[role]) continue;
      for (const field of ['name', 'email', 'date']) {
        if (credits[role][field] !== undefined)
          env[`GIT_${role.toUpperCase()}_${field.toUpperCase()}`] = credits[role][field];
      }
    }
    return this.text(
      ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])],
      message + (message.endsWith('\n') ? '' : '\n'),
      env,
    ).trim();
  }

  updateHead(branch, old, next) {
    try {
      this.git(['update-ref', `refs/heads/${branch}`, next, old ?? emptyOid]);
      return true;
    } catch (error) {
      if (error.status === 128 && this.resolve(branch) !== old) return false;
      throw error;
    }
  }
}
