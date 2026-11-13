// esbuild injects this `fetch` into the real Worker modules for the LOCAL scheduled-batch CPU gate
// (schedule.mjs). There is NO network fallback. The state is set by the runner on
// globalThis.__scheduleCpu = { files: Map<path, value> } and never changes, so every invocation
// sees the same head. Responses are cached by request body: after warm-up the harness costs a
// Map lookup per subrequest and the measured CPU is the Worker's own (parsing included).
const sha = 'a'.repeat(40);
const cache = new Map();
const text = (value) => JSON.stringify(value);

function listTree(files, dir, depth) {
  const prefix = `${dir}/`;
  const paths = [...files.keys()].filter((path) => path.startsWith(prefix));
  if (!paths.length) return null;
  const level = (base, left) => {
    const children = new Map();
    for (const path of paths) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      children.set(name, children.get(name) || slash >= 0);
    }
    return {
      entries: [...children].map(([name, isDir]) =>
        left <= 1 ? { name } : { name, object: isDir ? level(`${base}${name}/`, left - 1) : {} },
      ),
    };
  };
  return { object: level(prefix, depth) };
}

function graphql(body) {
  const { files } = globalThis.__scheduleCpu;
  const { query, variables } = JSON.parse(body);
  const blob = (value) =>
    value === undefined ? null : { oid: sha, isTruncated: false, text: text(value) };
  if (variables.branch) {
    const target = { oid: sha, tree: { oid: sha } };
    for (const [name, path] of Object.entries(variables)) {
      if (/^p\d+$/.test(name)) {
        const value = files.get(path);
        const i = name.slice(1);
        target[`o${i}`] =
          value === undefined
            ? null
            : query.includes(`o${i}:file(path:$p${i}){object{... on Blob{oid}}}`)
              ? { object: { oid: sha } }
              : { object: blob(value) };
      } else if (/^t\d+$/.test(name)) {
        const start = query.indexOf(`${name}:file(path:$${name})`);
        const end = query.indexOf(' t', start + 1);
        const depth = (query.slice(start, end < 0 ? undefined : end).match(/entries\{/g) ?? [])
          .length;
        target[name] = listTree(files, path, depth);
      }
    }
    return { data: { repository: { ref: { target } } } };
  }
  const repository = {};
  for (const [name, expression] of Object.entries(variables)) {
    if (!/^e\d+$/.test(name)) continue;
    repository[`o${name.slice(1)}`] = blob(
      files.get(expression.slice(expression.indexOf(':') + 1)),
    );
  }
  return { data: { repository } };
}

export async function fetch(input, init) {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const respond = (key, make, status = 200) => {
    let body = cache.get(key);
    if (body === undefined) cache.set(key, (body = text(make())));
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/aliases.json'))
    return respond('aliases', () => ({}));
  if (url.origin !== 'https://api.github.com') throw new Error(`CPU fixture blocked ${url.href}`);
  if (url.pathname.endsWith('/access_tokens') && method === 'POST')
    return respond('token', () => ({ token: 'synthetic' }));
  if (url.pathname === '/graphql' && method === 'POST')
    return respond(init.body, () => graphql(init.body));
  if (url.pathname.endsWith('/git/trees') && method === 'POST')
    return respond('sha', () => ({ sha }));
  if (url.pathname.endsWith('/git/commits') && method === 'POST')
    return respond('sha', () => ({ sha }));
  if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH')
    return respond('ref', () => ({ object: { sha } }));
  if (url.pathname.includes('/contents/publish/kicks/') && method === 'PUT')
    return respond('kick', () => ({ commit: { sha } }), 201);
  throw new Error(`CPU fixture blocked ${method} ${url.pathname}`);
}
