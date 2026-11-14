// esbuild injects this binding into the real Worker modules. There is NO network fallback.
import fixture from './dist/fixture.json';
const envelopeText = JSON.stringify(fixture.envelope);
const logText = JSON.stringify(fixture.log);
export async function fetch(input, init) {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  // Generator aliases (catalog.ts loadAliases): none, so every hash is its own canonical record.
  if (
    url.origin === 'https://raw.githubusercontent.com' &&
    url.pathname.endsWith('/templates/v2/aliases.json') &&
    method === 'GET'
  )
    return Response.json({});
  if (url.origin !== 'https://api.github.com') throw new Error('CPU fixture blocked external I/O');
  const json = (v) => Response.json(v);
  const sha = 'a'.repeat(40);
  if (url.pathname.endsWith('/access_tokens') && method === 'POST')
    return json({ token: 'synthetic' });
  if (url.pathname === '/graphql' && method === 'POST') {
    const { variables, query } = JSON.parse(init.body);
    if (!variables.branch) {
      // github.ts blobs(): `object(expression: "<sha>:<path>")` reads; an absent path is a silent
      // null (no error). Only the prepared tooltips exist (globals 2 and 3 are absent).
      const repository = {};
      for (let i = 0; variables[`e${i}`]; i++) {
        const match = /^[0-9a-f]{40}:tooltips\/([0-9]+)\.json$/.exec(variables[`e${i}`]);
        const tooltip = match ? fixture.tooltips[match[1]] : undefined;
        repository[`o${i}`] = tooltip
          ? { oid: sha, isTruncated: false, text: JSON.stringify(tooltip) }
          : null;
      }
      return json({ data: { repository } });
    }
    const target = { oid: sha, tree: { oid: sha } };
    for (let i = 0; variables[`p${i}`]; i++) {
      const path = variables[`p${i}`];
      let value = null;
      if (path === 'config/permissions.json')
        value = { users: { 1: { login: 'cpu', role: 'maintainer' } } };
      if (path.startsWith('publish/requests/') && fixture.mode !== 'publish')
        value = fixture.envelope;
      if (path.startsWith('publish/log/') && fixture.mode === 'terminal') value = fixture.log;
      target[`o${i}`] =
        value === null
          ? null
          : query.includes(`o${i}:file(path:$p${i}){object{... on Blob{oid}}}`)
            ? { object: { oid: sha } }
            : {
                object: {
                  oid: sha,
                  isTruncated: false,
                  text:
                    value === fixture.envelope
                      ? envelopeText
                      : value === fixture.log
                        ? logText
                        : JSON.stringify(value),
                },
              };
    }
    // GitHub pairs each absent Commit.file(path:) with a NOT_FOUND error (verified 2026-11-14).
    const errors = Object.keys(target)
      .filter((alias) => target[alias] === null)
      .map((alias) => ({
        type: 'NOT_FOUND',
        path: ['repository', 'ref', 'target', alias],
        locations: [{ line: 1, column: 1 }],
        message: `Could not resolve file for path '${alias}'.`,
      }));
    return json({
      data: { repository: { ref: { target } } },
      ...(errors.length ? { errors } : {}),
    });
  }
  if (url.pathname.endsWith('/git/trees') && method === 'POST') return json({ sha });
  if (url.pathname.endsWith('/git/commits') && method === 'POST') return json({ sha });
  if (url.pathname.endsWith('/git/refs/heads/cpu-data') && method === 'PATCH') return json({});
  if (url.pathname.includes('/contents/publish/kicks/') && method === 'PUT') return json({});
  throw new Error(`CPU fixture blocked ${method} ${url.pathname}`);
}
