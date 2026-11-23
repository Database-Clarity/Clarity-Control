import { createHash } from 'node:crypto';
import { branchPattern, oidPattern } from './sandbox-git.mjs';

const json = Response.json.bind(Response);
const error = (status, message) => json({ message }, { status });
const missing = () => error(404, 'Not Found in the disposable GitHub sandbox');
const invalid = () => error(422, 'Validation failed in the disposable GitHub sandbox');
const conflict = () => error(409, 'The disposable Git ref moved');
const blobLimit = 1_000_000;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const safePath = (path) =>
  typeof path === 'string' &&
  !path.includes('\\') &&
  [...path].every((character) => character.charCodeAt(0) >= 32) &&
  path.split('/').every((name) => name && name !== '.' && name !== '..');
const validOid = (oid) => typeof oid === 'string' && oidPattern.test(oid);
const blobResponse = (oid, bytes, encoding = 'base64') => ({
  sha: oid,
  size: bytes.length,
  encoding,
  content: encoding === 'base64' ? bytes.toString('base64') : '',
});

function rawResponse(path, bytes, method) {
  return new Response(method === 'HEAD' ? null : bytes, {
    headers: {
      'Content-Type': path.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    },
  });
}

function snapshot(git, head) {
  return new Map(git.treeEntries(head, true).map((entry) => [entry.name, entry]));
}

function latestCommits(git, head, path, count, skip = 0) {
  return git
    .text([
      'log',
      `--max-count=${count}`,
      `--skip=${skip}`,
      '--format=%H%x00%aN%x00%aE%x00%aI%x00%cI%x00%B%x00',
      head,
      '--',
      ...(path ? [path] : []),
    ])
    .split('\0')
    .reduce((entries, value, i, all) => {
      if (i % 6 !== 0 || !value.trim()) return entries;
      const [name, email, date, committedDate, message] = all.slice(i + 1, i + 6);
      const login = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];
      entries.push({
        sha: value.trim(),
        commit: {
          author: { name, date },
          committer: { date: committedDate },
          message: message.trimEnd(),
        },
        author: login ? { login } : null,
      });
      return entries;
    }, []);
}

function graphql(git, { query, variables: vars }, bindings) {
  if (
    typeof query !== 'string' ||
    vars?.owner !== bindings.GITHUB_OWNER ||
    vars.name !== bindings.GITHUB_REPO
  )
    return invalid();
  const repository = {};
  const errors = [];
  const snapshots = new Map();
  const at = (ref) => {
    if (!snapshots.has(ref)) {
      const head = git.resolve(ref);
      snapshots.set(ref, head && { head, files: snapshot(git, head) });
    }
    return snapshots.get(ref);
  };
  const blobReaders = [];
  const selectBlob = (entry, fields, set) => {
    if (!entry) return set(null);
    if (entry.type !== 'blob') return set({});
    if (fields === 'oid') return set({ oid: entry.oid });
    blobReaders.push({ oid: entry.oid, set, raw: fields === 'raw' });
  };
  const listing = (tree, depth, withBlobs = false) => ({
    entries: git.treeEntries(tree.oid).map((entry) => {
      const result = { name: entry.name };
      if (depth > 1) result.object = entry.type === 'tree' ? listing(entry, depth - 1) : {};
      if (withBlobs) selectBlob(entry, 'text', (blob) => (result.object = blob));
      return result;
    }),
  });

  if (query.includes('ref(qualifiedName:$branch)')) {
    const data = at(vars.branch);
    repository.ref = null;
    if (data) {
      const { head, files } = data;
      const target = { oid: head };
      repository.ref = { target };
      if (query.includes('tree{oid}'))
        target.tree = { oid: git.text(['rev-parse', `${head}^{tree}`]).trim() };
      const matches = [...query.matchAll(/\b([a-z]\w*):file\(path:\$([a-z]\w*)\)/g)];
      for (const [index, match] of matches.entries()) {
        const [, alias, variable] = match;
        if (!/^(?:[otbx]\d+|perm|config|dir)$/.test(alias) || !safePath(vars[variable]))
          return invalid();
        const path = vars[variable],
          entry = files.get(path);
        const selection = query.slice(match.index + match[0].length, matches[index + 1]?.index);
        if (!entry) {
          target[alias] = null;
          errors.push({ type: 'NOT_FOUND', path: ['repository', 'ref', 'target', alias] });
        } else if (selection.startsWith('{type oid')) {
          target[alias] = { type: entry.type, oid: entry.oid };
          if (selection.startsWith('{type oid object')) {
            target[alias].object =
              entry.type === 'tree'
                ? {
                    entries: git.treeEntries(entry.oid).map(({ name, mode, oid }) => ({
                      nameRaw: Buffer.from(name).toString('base64'),
                      mode: Number.parseInt(mode, 8),
                      oid,
                    })),
                  }
                : {};
          }
        } else if (selection.startsWith('{object{... on Tree{')) {
          const depth = (selection.match(/entries\{/g) ?? []).length;
          if (depth < 1 || depth > 3) return invalid();
          target[alias] = {
            object:
              entry.type === 'tree' ? listing(entry, depth, selection.includes('... on Blob')) : {},
          };
        } else {
          const fields = selection.startsWith('{object{... on Blob{oid}}}')
            ? 'oid'
            : selection.startsWith('{object{... on Blob{oid byteSize')
              ? 'raw'
              : 'text';
          selectBlob(entry, fields, (object) => (target[alias] = { object }));
        }
      }
      if (query.includes('last:history(first:1,path:$config)')) {
        const [last] = latestCommits(git, head, vars.config, 1);
        target.last = { nodes: last ? [{ committedDate: last.commit.committer.date }] : [] };
      }
    }
    if (query.includes('live:ref(qualifiedName:$live)')) {
      const oid = git.resolve(vars.live);
      repository.live = oid ? { target: { oid } } : null;
    }
  } else if (query.includes('object(oid:$oid)')) {
    if (!validOid(vars.oid)) return invalid();
    const entry = git.objects([vars.oid]).get(vars.oid);
    selectBlob(entry, 'raw', (blob) => (repository.object = blob));
  } else {
    const expression = (value) => {
      if (typeof value !== 'string') return undefined;
      const colon = value.indexOf(':');
      const ref = value.slice(0, colon),
        path = value.slice(colon + 1);
      return colon > 0 && safePath(path) ? at(ref)?.files.get(path) : undefined;
    };
    const selections = [...query.matchAll(/\b(o\d+):object\(expression:\$(e\d+)\)/g)];
    if (query.includes('object(expression:$e){oid}')) {
      const entry = expression(vars.e);
      repository.object = entry ? { oid: entry.oid } : null;
    } else if (selections.length) {
      const fields = query.includes('fragment R on Blob') ? 'raw' : 'text';
      for (const [, alias, variable] of selections)
        selectBlob(expression(vars[variable]), fields, (blob) => (repository[alias] = blob));
    } else {
      return invalid();
    }
  }
  const blobs = git.objects(blobReaders.map(({ oid }) => oid));
  for (const { oid, set, raw } of blobReaders) {
    const { bytes } = blobs.get(oid);
    const isTruncated = bytes.length > blobLimit;
    let text = null;
    let isBinary = bytes.includes(0);
    if (!isBinary && !isTruncated) {
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        isBinary = true;
      }
    }
    set({ oid, isTruncated, text, ...(raw ? { byteSize: bytes.length, isBinary } : {}) });
  }
  return json({ data: { repository }, ...(errors.length ? { errors } : {}) });
}

function creditsValid(input) {
  return ['author', 'committer'].every((role) => {
    const value = input[role];
    return (
      value === undefined ||
      (value &&
        ['name', 'email'].every(
          (key) =>
            typeof value[key] === 'string' && value[key].length && !/[<>\r\n\0]/.test(value[key]),
        ) &&
        (value.date === undefined ||
          (typeof value.date === 'string' && Number.isFinite(Date.parse(value.date)))))
    );
  });
}

function dataRest(git, path, url, method, input, headers, bindings, onDataWrite) {
  const branchOK = (branch) => typeof branch === 'string' && branchPattern.test(branch);
  const update = (branch, old, next) => {
    if (!git.updateHead(branch, old, next)) return false;
    if (branch === bindings.DATA_BRANCH) onDataWrite();
    return true;
  };
  if (method === 'GET') {
    if (path.startsWith('git/ref/heads/')) {
      const branch = path.slice('git/ref/heads/'.length);
      const sha = branchOK(branch) && git.resolve(branch);
      return sha ? json({ object: { sha } }) : missing();
    }
    if (path.startsWith('git/commits/')) {
      const sha = path.slice('git/commits/'.length);
      if (!validOid(sha) || !git.resolve(sha)) return missing();
      const text = git.text(['cat-file', 'commit', sha]);
      const split = text.indexOf('\n\n');
      const fields = text.slice(0, split);
      return json({
        sha,
        message: text.slice(split + 2),
        tree: { sha: /^tree (\w+)$/m.exec(fields)[1] },
        parents: [...fields.matchAll(/^parent (\w+)$/gm)].map(([, sha]) => ({ sha })),
      });
    }
    if (path.startsWith('git/blobs/')) {
      const id = path.slice('git/blobs/'.length);
      const entry = validOid(id) && git.objects([id]).get(id);
      if (entry?.type !== 'blob') return missing();
      return headers.get('Accept')?.includes('application/vnd.github.raw')
        ? rawResponse('', entry.bytes, method)
        : json(blobResponse(id, entry.bytes));
    }
    if (path.startsWith('contents/')) {
      const file = path.slice('contents/'.length);
      const head = git.resolve(url.searchParams.get('ref') ?? bindings.DATA_BRANCH);
      if (!head || !safePath(file)) return missing();
      const [entry] = git.treeEntries(head, false, file);
      if (entry?.type === 'tree')
        return json(
          git.treeEntries(entry.oid).map((child) => ({
            name: child.name,
            path: `${file}/${child.name}`,
            sha: child.oid,
            type: child.type === 'tree' ? 'dir' : 'file',
          })),
        );
      if (entry?.type !== 'blob') return missing();
      const bytes = git.blob(entry.oid);
      return json(blobResponse(entry.oid, bytes, bytes.length > blobLimit ? 'none' : 'base64'));
    }
    if (path === 'commits') {
      const head = git.resolve(url.searchParams.get('sha') ?? bindings.DATA_BRANCH);
      const file = url.searchParams.get('path');
      const count = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      if (!head) return missing();
      if (
        (file !== null && !safePath(file)) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100 ||
        !Number.isSafeInteger((page - 1) * count) ||
        !Number.isInteger(page) ||
        page < 1
      )
        return invalid();
      return json(latestCommits(git, head, file, count, (page - 1) * count));
    }
    if (path.startsWith('compare/')) {
      const refs = path.slice('compare/'.length).split('...');
      const [base, head] = refs.map((ref) => git.resolve(ref));
      if (refs.length !== 2 || !base || !head) return missing();
      const [behind_by, ahead_by] = git
        .text(['rev-list', '--left-right', '--count', `${base}...${head}`])
        .trim()
        .split(/\s+/)
        .map(Number);
      return json({
        status:
          ahead_by && behind_by
            ? 'diverged'
            : ahead_by
              ? 'ahead'
              : behind_by
                ? 'behind'
                : 'identical',
        ahead_by,
        behind_by,
      });
    }
    return missing();
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  if (method === 'POST' && path === 'git/trees') {
    const hasBase = input.base_tree !== undefined;
    if (!Array.isArray(input.tree) || (hasBase && !validOid(input.base_tree))) return invalid();
    const entries = input.tree;
    if (
      entries.some(
        (entry) =>
          !entry ||
          !safePath(entry.path) ||
          entry.type !== 'blob' ||
          !['100644', '100755', '120000'].includes(entry.mode) ||
          (Object.hasOwn(entry, 'content')
            ? typeof entry.content !== 'string' || Object.hasOwn(entry, 'sha')
            : entry.sha !== null && !validOid(entry.sha)),
      )
    )
      return invalid();
    const objects = git.objects([
      ...(hasBase ? [input.base_tree] : []),
      ...entries.map(({ sha }) => sha).filter(validOid),
    ]);
    if (
      (hasBase && objects.get(input.base_tree)?.type !== 'tree') ||
      entries.some(({ sha }) => validOid(sha) && objects.get(sha)?.type !== 'blob')
    )
      return invalid();
    const sha = git.writeTree(
      input.base_tree,
      entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        oid: typeof entry.content === 'string' ? git.writeBlob(entry.content) : entry.sha,
      })),
    );
    return json({ sha }, { status: 201 });
  }
  if (method === 'POST' && path === 'git/commits') {
    const { tree, parents, message } = input;
    if (
      !validOid(tree) ||
      !Array.isArray(parents) ||
      !parents.every(validOid) ||
      typeof message !== 'string' ||
      !creditsValid(input)
    )
      return invalid();
    const objects = git.objects([tree, ...parents]);
    if (
      objects.get(tree)?.type !== 'tree' ||
      parents.some((oid) => objects.get(oid)?.type !== 'commit')
    )
      return invalid();
    const sha = git.commit(tree, parents, message, input);
    return json({ sha }, { status: 201 });
  }
  if (method === 'POST' && path === 'git/refs') {
    const branch = /^refs\/heads\/(.*)$/.exec(input.ref)?.[1];
    if (!branchOK(branch) || !validOid(input.sha) || !git.resolve(input.sha)) return invalid();
    if (git.resolve(branch) || !update(branch, undefined, input.sha)) return invalid();
    return json({ object: { sha: input.sha } }, { status: 201 });
  }
  if (method === 'PATCH' && path.startsWith('git/refs/heads/')) {
    const branch = path.slice('git/refs/heads/'.length);
    if (!branchOK(branch) || input.force !== false || !validOid(input.sha)) return invalid();
    const old = git.resolve(branch);
    if (!old) return missing();
    const next = git.resolve(input.sha);
    if (!next) return invalid();
    // The Worker builds a sole-parent commit against its observed head. Reusing a
    // sibling or any stale parent must fail, even across publisher writes.
    const parents = git.text(['rev-list', '--parents', '-1', next]).trim().split(' ').slice(1);
    if (old !== next && (parents.length !== 1 || parents[0] !== old)) return invalid();
    return update(branch, old, next) ? json({ object: { sha: next } }) : conflict();
  }
  if (method === 'PUT' && path.startsWith('contents/')) {
    const file = path.slice('contents/'.length);
    const { branch, sha, message, content } = input;
    if (
      !safePath(file) ||
      !branchOK(branch) ||
      typeof message !== 'string' ||
      typeof content !== 'string' ||
      !base64.test(content) ||
      !creditsValid(input)
    )
      return invalid();
    const old = git.resolve(branch);
    if (!old) return missing();
    const [current] = git.treeEntries(old, false, file);
    if (current?.oid !== sha || (current && current.type !== 'blob')) return invalid();
    const oid = git.writeBlob(Buffer.from(content, 'base64'));
    const tree = git.writeTree(old, [{ path: file, mode: current?.mode ?? '100644', oid }]);
    const next = git.commit(tree, [old], message, input);
    return update(branch, old, next)
      ? json({ commit: { sha: next }, content: { sha: oid } }, { status: current ? 200 : 201 })
      : conflict();
  }
  return missing();
}

export function createAdapter({ repos, bindings, siteOrigin, onDataWrite = () => {} }) {
  const data = repos[bindings.GITHUB_REPO];
  let run;
  const accounts = new Map();
  return async (request) => {
    const { method, headers } = request;
    try {
      const url = new URL(request.url);
      const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
      const [first, second, third, ...rest] = parts;
      const path = rest.join('/');
      const read = method === 'GET' || method === 'HEAD';
      const owner = bindings.GITHUB_OWNER;
      if (
        url.origin === 'https://raw.githubusercontent.com' &&
        read &&
        first === owner &&
        Object.hasOwn(repos, second) &&
        safePath(path)
      ) {
        const git = repos[second];
        const head = git.resolve(third);
        if (!head) return missing();
        const [entry] = git.treeEntries(head, false, path);
        return entry?.type === 'blob' ? rawResponse(path, git.blob(entry.oid), method) : missing();
      }
      if (
        url.origin === 'https://challenges.cloudflare.com' &&
        url.pathname === '/turnstile/v0/siteverify' &&
        method === 'POST'
      ) {
        const input = new URLSearchParams(await request.text());
        return json({ success: input.get('response') === 'clarity-local-turnstile' });
      }
      if (url.origin !== 'https://api.github.com') return missing();
      if (
        method === 'POST' &&
        url.pathname === `/app/installations/${bindings.GITHUB_INSTALLATION_ID}/access_tokens`
      ) {
        const input = await request.json();
        if (
          !Array.isArray(input?.repositories) ||
          input.repositories.length !== 1 ||
          !Object.hasOwn(repos, input.repositories[0]) ||
          !input.permissions ||
          typeof input.permissions !== 'object' ||
          Array.isArray(input.permissions) ||
          Object.entries(input.permissions).some(
            ([key, value]) =>
              !['contents', 'actions'].includes(key) || !['read', 'write'].includes(value),
          )
        )
          return invalid();
        return json(
          {
            token: 'clarity-disposable-installation',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/graphql' && method === 'POST')
        return graphql(data, await request.json(), bindings);
      if (
        method === 'GET' &&
        first === 'users' &&
        parts.length === 2 &&
        /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(second)
      ) {
        const login = second.toLowerCase();
        const [permissions] = data.treeEntries(
          data.resolve(bindings.DATA_BRANCH),
          false,
          'config/permissions.json',
        );
        const users = JSON.parse(data.blob(permissions.oid)).users;
        for (const [id, user] of Object.entries(users)) {
          if (user.login.toLowerCase() === login)
            return json({ id: Number(id), login: user.login, type: 'User' });
        }
        if (!/^(?:dev-|clarity-local-)/.test(login)) return missing();
        if (!accounts.has(login)) {
          let id = 2 ** 40 + createHash('sha256').update(login).digest().readUInt32BE();
          while (Object.hasOwn(users, id) || [...accounts.values()].includes(id)) id++;
          accounts.set(login, id);
        }
        return json({ id: accounts.get(login), login, type: 'User' });
      }
      if (first !== 'repos' || second !== owner) return missing();
      if (method === 'GET' && third === bindings.GENERATOR_REPO && path.startsWith('commits/')) {
        const sha = repos[third].resolve(path.slice('commits/'.length));
        return sha ? json({ sha }) : missing();
      }
      if (
        third === bindings.COMPENDIUM_REPO &&
        path.startsWith(`actions/workflows/${bindings.COMPENDIUM_WORKFLOW}/`)
      ) {
        const action = rest.length === 4 ? rest[3] : null;
        if (
          method === 'GET' &&
          action === 'runs' &&
          url.searchParams.get('branch') === bindings.COMPENDIUM_REF
        )
          return json({ workflow_runs: run ? [run] : [] });
        if (
          method === 'POST' &&
          action === 'dispatches' &&
          (await request.json())?.ref === bindings.COMPENDIUM_REF
        ) {
          run = {
            id: (run?.id ?? 0) + 1,
            status: 'completed',
            conclusion: 'success',
            created_at: new Date().toISOString(),
            html_url: siteOrigin,
          };
          return new Response(null, { status: 204 });
        }
        return missing();
      }
      if (third !== bindings.GITHUB_REPO) return missing();
      const input = ['POST', 'PATCH', 'PUT'].includes(method) ? await request.json() : undefined;
      return dataRest(data, path, url, method, input, headers, bindings, onDataWrite);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof URIError || err.status === 128)
        return invalid();
      console.error('Disposable GitHub request failed:', err.message.split('\n')[0]);
      return error(500, 'Disposable GitHub request failed');
    }
  };
}
