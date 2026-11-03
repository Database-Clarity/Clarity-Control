// esbuild injects this binding into the real Worker modules. There is NO network fallback.
import fixture from './dist/fixture.json';
export async function fetch(input, init) {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  if (url.origin !== 'https://api.github.com') throw new Error('CPU fixture blocked external I/O');
  const json = (v) => Response.json(v);
  const sha = 'a'.repeat(40);
  if (url.pathname.endsWith('/access_tokens') && method === 'POST')
    return json({ token: 'synthetic' });
  if (url.pathname === '/graphql' && method === 'POST') {
    const { variables } = JSON.parse(init.body);
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
          : { object: { oid: sha, isTruncated: false, text: JSON.stringify(value) } };
    }
    return json({ data: { repository: { ref: { target } } } });
  }
  if (url.pathname.endsWith('/git/trees') && method === 'POST') return json({ sha });
  if (url.pathname.endsWith('/git/commits') && method === 'POST') return json({ sha });
  if (url.pathname.endsWith('/git/refs/heads/cpu-data') && method === 'PATCH') return json({});
  if (url.pathname.includes('/contents/publish/kicks/') && method === 'PUT') return json({});
  throw new Error(`CPU fixture blocked ${method} ${url.pathname}`);
}
