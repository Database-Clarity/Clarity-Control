// Execute the production S2 validator against an immutable, in-memory repository.
// No network or Git write is available to this adapter.
import { aliasGroupsRoute } from '../../apps/worker/src/aliasGroups.js';
import { blobContent, blobSha, type GitHub, type RepoFile } from '../../apps/worker/src/github.js';
import { aliasGroupFactsDigest, type AliasItems } from '../../packages/core/src/index.js';
export {
  composeAliases,
  emptyAliasGroups,
  exportLegacy,
  readAliasProposals,
  parseMarkup,
  publishableHash,
  resolveAlias,
  languages,
} from '../../packages/core/src/index.js';
export {
  buildLegacy,
  legacyPresets,
  compile,
  newStyleFile,
  styles,
  defaultData,
} from '../../packages/export/src/index.js';

export interface Selection {
  canonical: number;
  members: number[];
  acknowledgeConflicts?: true;
}
export async function validate(
  initial: Record<string, string>,
  head: string,
  facts: { items: AliasItems; aliases: unknown; sandboxConflicts: unknown; categories: unknown },
  selections: Selection[],
  actor: { id: number; login: string },
  at: string,
) {
  const files = new Map(Object.entries(initial));
  const blobs = new Map<string, string>();
  const parsed = new Map<string, RepoFile>();
  for (const raw of files.values()) blobs.set(await blobSha(raw), raw);
  const read = async (path: string): Promise<RepoFile | null> => {
    const raw = files.get(path);
    if (raw === undefined) return null;
    let value = parsed.get(raw);
    if (!value) {
      value = { sha: await blobSha(raw), value: JSON.parse(raw) };
      parsed.set(raw, value);
    }
    return value;
  };
  const repo = {
    env: { GENERATOR_OWNER: 'offline', GENERATOR_REPO: 'facts', GENERATOR_BRANCH: 'a'.repeat(40) },
    spend() {},
    head: async () => head,
    file: read,
    requiredFile: async (path: string) => {
      const value = await read(path);
      if (!value) throw new Error(`Missing ${path}`);
      return value;
    },
    files: async (paths: string[]) => Promise.all(paths.map(read)),
    publishSnapshot: async () => ({
      head,
      trees: [
        [...files.keys()]
          .filter((path) => /^tooltips\/[0-9]+\.json$/.test(path))
          .map((path) => ({ name: path.slice(9) })),
      ],
    }),
    commit: async (
      expected: string,
      writes: Record<string, unknown>,
      _message: string,
      _user: unknown,
      options: { blobRefs?: Record<string, string>; deletions?: string[] },
    ) => {
      if (expected !== head) throw new Error('Stale data head');
      for (const [path, value] of Object.entries(writes)) {
        const raw = blobContent(value);
        files.set(path, raw);
        blobs.set(await blobSha(raw), raw);
      }
      for (const path of options.deletions ?? []) files.delete(path);
      for (const [path, sha] of Object.entries(options.blobRefs ?? {})) {
        const raw = blobs.get(sha);
        if (raw === undefined) throw new Error(`Missing archive blob ${sha}`);
        files.set(path, raw);
      }
      return head;
    },
  };
  // This CLI is single-threaded. Freeze audit timestamps for exact plan regeneration,
  // and fail closed on any request outside the four local generator documents.
  const originalFetch = globalThis.fetch;
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(value: string | number = at) {
      super(value);
    }
    static now() {
      return new OriginalDate(at).getTime();
    }
  } as DateConstructor;
  globalThis.fetch = async (input) => {
    const prefix = `https://raw.githubusercontent.com/offline/facts/${'a'.repeat(40)}/templates/v2/`;
    const url = String(input);
    if (!url.startsWith(prefix)) throw new Error(`Offline fetch refused: ${url}`);
    const name = url.slice(prefix.length).replace(/\.json$/, '');
    if (!Object.hasOwn(facts, name)) throw new Error(`Unknown local fact ${name}`);
    return Response.json(facts[name as keyof typeof facts]);
  };
  const responses: unknown[] = [];
  try {
    // Single approved selections permit the armour exception. Each still passes
    // every S2 locale, archive, composition, and real import-resolver check.
    for (const selection of selections) {
      const op = {
        op: 'accept',
        ...selection,
        factsDigest: await aliasGroupFactsDigest(selection.members, facts.items),
      };
      const response = await aliasGroupsRoute(
        new Request('https://offline/alias-groups', {
          method: 'POST',
          body: JSON.stringify({ expectedHead: head, ops: [op] }),
        }),
        repo as unknown as GitHub,
        actor,
      );
      responses.push(await response.json());
    }
    return { files: Object.fromEntries(files), responses };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Date = OriginalDate;
  }
}
