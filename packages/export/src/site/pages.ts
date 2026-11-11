// Where the current site lives (spec section 3, "build-site steps" and "Bootstrap"): the Pages
// project's served (canonical) deployment and its own URL, read through the Pages API, never
// through the cached public host. The dry-run harness uses a local folder instead (`--pages-sim`).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SiteState =
  | { zeroDeployments: true; deployment: null }
  | { zeroDeployments: false; deployment: { id: string; url: string } };

type ApiDeployment = { id?: string; url?: string };

async function api<T>(path: string, token: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { success?: boolean; result?: T; errors?: unknown };
      if (!response.ok || !body.success)
        throw new Error(
          `Pages API ${response.status}: ${JSON.stringify(body.errors ?? null).slice(0, 300)}`,
        );
      return body.result as T;
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** A deployment URL must be the project's own pages.dev host (it is used to fetch carried files). */
export function checkDeploymentUrl(url: string, project: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (
    parsed.protocol !== 'https:' ||
    !(host === `${project}.pages.dev` || host.endsWith(`.${project}.pages.dev`))
  )
    throw new Error(`Unexpected deployment URL ${url}`);
  return `${parsed.origin}/`;
}

/** Real Pages project: zero deployments (bootstrap) or the served deployment's own URL. */
export async function locatePages(
  accountId: string,
  project: string,
  token: string,
): Promise<SiteState> {
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[a-z0-9-]{1,58}$/.test(project))
    throw new Error('Bad account id or project name');
  const base = `/accounts/${accountId}/pages/projects/${project}`;
  const deployments = await api<ApiDeployment[]>(
    `${base}/deployments?env=production&per_page=1`,
    token,
  );
  const info = await api<{ canonical_deployment?: ApiDeployment | null }>(base, token);
  const canonical = info.canonical_deployment;
  if (!deployments.length && !canonical) return { zeroDeployments: true, deployment: null };
  // Deployments exist: the served one must be known, or nothing deploys (spec: corrupt or missing).
  if (!canonical?.id || !canonical.url)
    throw new Error('The Pages project has deployments but no served deployment');
  return {
    zeroDeployments: false,
    deployment: { id: canonical.id, url: checkDeploymentUrl(canonical.url, project) },
  };
}

/**
 * Dry-run Pages: `<dir>/deployments/<id>/` folders and `<dir>/canonical` naming the served one.
 * No `canonical` file and no deployments means zero deployments.
 */
export function locateSim(dir: string): SiteState {
  const canonicalPath = join(dir, 'canonical');
  if (!existsSync(canonicalPath)) {
    if (existsSync(join(dir, 'deployments')))
      throw new Error('Simulated Pages has deployments but no served one');
    return { zeroDeployments: true, deployment: null };
  }
  const id = readFileSync(canonicalPath, 'utf8').trim();
  if (!/^[0-9]{1,6}$/.test(id)) throw new Error('Bad simulated deployment id');
  return {
    zeroDeployments: false,
    deployment: { id, url: pathToFileURL(join(dir, 'deployments', id)).href + '/' },
  };
}
