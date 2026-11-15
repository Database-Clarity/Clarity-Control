import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import {
  aliasGroupFactsDigest,
  aliasGroupsPath,
  emptyAliasGroups,
  migrateLegacy,
  parseMarkup,
  type AliasGroups,
  type AliasGroupsResponse,
  type AliasItems,
  type AliasGroupOperation,
} from '@clarity/core';
import { aliasGroupsRoute } from '../src/aliasGroups.js';
import { GitHub, RefRace, blobContent, blobSha, type RepoFile } from '../src/github.js';
import { exporter } from '../src/elementTags.js';
import { config, sha, tooltip } from './fixture.js';
import { database } from '../../../packages/core/test/helpers.js';

const actor = { id: 1, login: 'alice' };
const item = (hash: number) => ({
  hash,
  name: 'Perk',
  categoryId: 'weapon-trait',
  plugCategoryHash: 20,
  inGameDescription: 'Same text',
});
let items: Record<string, AliasItems[string]>;
let repo: GitHub;
let head: string;
let files: Map<string, string>;
let blobs: Map<string, string>;
let writes: MockInstance<GitHub['commit']>;
let generated: unknown;
let conflicts: unknown;
let generatorUrls: string[];

async function put(path: string, value: unknown, raw = blobContent(value)) {
  const oid = await blobSha(raw);
  blobs.set(oid, raw);
  files.set(path, oid);
}
function read(path: string): RepoFile | null {
  const oid = files.get(path);
  return oid ? { sha: oid, value: JSON.parse(blobs.get(oid)!) as unknown } : null;
}
const document = (hash: number, text = 'Body') => ({ ...tooltip(text), hash });
const groups = () => read(aliasGroupsPath)?.value as AliasGroups;
async function intent(
  op: 'accept' | 'split' | 'reject' = 'accept',
  members = [42, 43],
  canonical = members[0]!,
) {
  return {
    op,
    ...(op === 'reject' ? {} : { canonical }),
    members,
    factsDigest: await aliasGroupFactsDigest(members, items),
  } as AliasGroupOperation;
}
async function run(ops?: AliasGroupOperation[], user = actor, expectedHead = head) {
  const response = await aliasGroupsRoute(
    new Request('https://api.example/alias-groups', {
      method: ops ? 'POST' : 'GET',
      ...(ops ? { body: JSON.stringify({ expectedHead, ops }) } : {}),
    }),
    repo,
    user,
  );
  return (await response.json()) as AliasGroupsResponse;
}
beforeEach(async () => {
  head = sha(10);
  items = Object.fromEntries([42, 43, 44, 45, 46].map((hash) => [hash, item(hash)]));
  generated = {};
  conflicts = {};
  generatorUrls = [];
  files = new Map();
  blobs = new Map();
  repo = new GitHub({
    GENERATOR_OWNER: 'org',
    GENERATOR_REPO: 'gen',
    GENERATOR_BRANCH: 'v2',
  } as GitHub['env']);
  vi.spyOn(repo, 'head').mockImplementation(async () => head);
  vi.spyOn(repo, 'file').mockImplementation(async (path) => read(path));
  vi.spyOn(repo, 'files').mockImplementation(async (paths) => paths.map(read));
  vi.spyOn(repo, 'publishSnapshot').mockImplementation(async () => ({
    head,
    tree: head,
    files: [],
    trees: [
      [...files.keys()]
        .filter((path) => /^tooltips\/[0-9]+\.json$/.test(path))
        .map((path) => ({ name: path.slice('tooltips/'.length) })),
    ],
  }));
  writes = vi
    .spyOn(repo, 'commit')
    .mockImplementation(async (expected, changes, _message, _user, options = {}) => {
      expect(expected).toBe(head);
      for (const [path, value] of Object.entries(changes)) await put(path, value);
      for (const path of options.deletions ?? []) {
        if (!files.has(path)) throw new Error(`Cannot delete absent path: ${path}`);
        files.delete(path);
      }
      for (const [path, oid] of Object.entries(options.blobRefs ?? {})) {
        expect(blobs.has(oid)).toBe(true);
        files.set(path, oid);
      }
      head = sha(Number.parseInt(head, 16) + 1);
      return head;
    });
  vi.spyOn(exporter, 'publisherEnabled').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      generatorUrls.push(url);
      if (url.endsWith('/commits/v2')) return Response.json({ sha: sha(100) });
      if (!url.includes(`/${sha(100)}/templates/v2/`))
        throw new Error(`Unpinned generator fetch: ${url}`);
      if (url.endsWith('/items.json')) return Response.json(items);
      if (url.endsWith('/aliases.json')) return Response.json(generated);
      if (url.endsWith('/sandboxConflicts.json')) return Response.json(conflicts);
      if (url.endsWith('/categories.json'))
        return Response.json([{ id: 'weapon-trait', legacyType: 'Weapon Trait' }]);
      throw new Error(url);
    }),
  );
  await put('config/permissions.json', config);
  await put('.publisher/PIN', { capabilities: ['aliasGroups'] });
  await put('tooltips/42.json', document(42));
  await put('tooltips/43.json', document(43));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('returns an empty snapshot and reads all generator facts at one immutable revision', async () => {
  expect(await run()).toEqual({
    head,
    config: emptyAliasGroups(),
    issues: [],
    affectedCanonicals: [],
  });
  expect(generatorUrls).toHaveLength(5);
  expect(writes).not.toHaveBeenCalled();
});

it.each([2, 3, 4, 5, 7])('refuses GET and POST for role %s before facts or writes', async (id) => {
  for (const ops of [undefined, [await intent()]]) {
    await expect(run(ops, { id, login: 'other' })).rejects.toMatchObject({ status: 403 });
  }
  expect(generatorUrls).toEqual([]);
  expect(writes).not.toHaveBeenCalled();
});

it('atomically archives exact CRLF/non-ASCII blobs, absence, and removes only noncanonical tooltips', async () => {
  const raw =
    JSON.stringify(document(43, 'Café — Ελληνικά'), null, 4).replaceAll('\n', '\r\n') + '\r\n';
  await put('tooltips/43.json', null, raw);
  const before = new Map(files);
  const result = await run([
    {
      ...(await intent('accept', [42, 43, 44])),
      acknowledgeConflicts: true,
    } as AliasGroupOperation,
  ]);
  expect(result.affectedCanonicals).toEqual([42, 43, 44]);
  expect(read('tooltips/43.json')).toBeNull();
  expect(writes.mock.calls[0]![4]?.deletions).not.toContain('tooltips/44.json');
  const archive = result.config.archives![0]!;
  expect(archive.files).toEqual({
    42: before.get('tooltips/42.json'),
    43: before.get('tooltips/43.json'),
    44: null,
  });
  expect(blobs.get(files.get(`${archive.path.slice(0, -5)}/43.json`)!)).toBe(raw);
  expect(result.config.groups[42]).toMatchObject({ by: { id: '1', login: 'alice' } });
  const restored = await run([{ op: 'ungroup', canonical: 42 }]);
  expect(restored.config.groups).toEqual({});
  expect(restored.config.archives).toEqual(result.config.archives);
  expect(files.get('tooltips/42.json')).toBe(before.get('tooltips/42.json'));
  expect(blobs.get(files.get('tooltips/43.json')!)).toBe(raw);
  expect(read('tooltips/44.json')).toBeNull();
  expect(writes.mock.calls[1]![4]?.deletions).not.toContain('tooltips/44.json');
  expect(writes).toHaveBeenCalledTimes(2);
});

it('requires explicit conflict acknowledgement and refuses a missing locale even with acknowledgement', async () => {
  await put('tooltips/43.json', document(43, 'Different'));
  await expect(run([await intent()])).rejects.toMatchObject({
    status: 422,
    message: expect.stringContaining('acknowledge'),
  });
  const translated = document(43);
  Object.assign(translated.text, { de: { ...translated.text.en, text: 'Deutsch' } });
  await put('tooltips/43.json', translated);
  await expect(
    run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]),
  ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('lacks de') });
  expect(writes).not.toHaveBeenCalled();
});

it('checks metadata conflicts and never synthesizes a document', async () => {
  await put('tooltips/43.json', { ...document(43), associated: [55] });
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  const selected = files.get('tooltips/43.json');
  await run([
    {
      ...(await intent('accept', [42, 43], 43)),
      acknowledgeConflicts: true,
    } as AliasGroupOperation,
  ]);
  expect(files.get('tooltips/43.json')).toBe(selected);
});

it('accepts split subsets, stamps rejections, and invalidates stale membership/facts digests', async () => {
  const reject = await intent('reject');
  const result = await run([reject]);
  expect(Object.values(result.config.rejected)[0]).toMatchObject({
    by: { id: '1', login: 'alice' },
  });
  items[43] = { ...items[43]!, inGameDescription: 'New facts' };
  await expect(run([reject])).rejects.toMatchObject({ status: 409 });
  const accepted = await run([await intent('split', [42, 44])]);
  expect(accepted.config.groups[42]!.members).toEqual([42, 44]);
  expect(read('tooltips/43.json')).not.toBeNull();
});

it('allows manual acceptance of a rejected digest and preserves its rejection history', async () => {
  const reject = { ...(await intent('reject')), reason: 'Previously declined' };
  const rejected = (await run([reject])).config.rejected;
  const accepted = await run([await intent()]);
  expect(accepted.config.groups[42]!.members).toEqual([42, 43]);
  expect(accepted.config.rejected).toEqual(rejected);
});

it('bounds member counts, notes, and rejection reasons before reading facts or writing', async () => {
  const accept = (await intent()) as Extract<AliasGroupOperation, { op: 'accept' }>;
  const reject = (await intent('reject')) as Extract<AliasGroupOperation, { op: 'reject' }>;
  for (const op of [
    { ...accept, members: Array.from({ length: 257 }, (_, i) => 42 + i) },
    { ...reject, members: Array.from({ length: 257 }, (_, i) => 42 + i) },
    { ...accept, note: 'x'.repeat(501) },
    { ...reject, reason: 'x'.repeat(501) },
  ]) {
    await expect(run([op])).rejects.toMatchObject({ status: 400 });
  }
  expect(generatorUrls).toEqual([]);
  expect(writes).not.toHaveBeenCalled();
  await run([{ ...reject, reason: 'x'.repeat(500) }]);
  expect((await run([{ ...accept, note: 'x'.repeat(500) }])).config.groups[42]!.note).toHaveLength(
    500,
  );
});

it('rejects stale heads and ref races without a rebase or retry', async () => {
  const accept = await intent();
  await expect(run([accept], actor, sha(1))).rejects.toMatchObject({ status: 409 });
  expect(generatorUrls).toEqual([]);
  writes.mockRejectedValue(new RefRace());
  await expect(run([accept])).rejects.toMatchObject({ status: 409 });
  expect(writes).toHaveBeenCalledTimes(1);
});

it.each(['no capability', 'publisher disabled'])(
  'holds mutations when %s, while allowing rejections',
  async (mode) => {
    if (mode === 'no capability') await put('.publisher/PIN', { capabilities: [] });
    else vi.mocked(exporter.publisherEnabled).mockReturnValue(false);
    await expect(run([await intent()])).rejects.toMatchObject({ status: 409 });
    expect(writes).not.toHaveBeenCalled();
    await run([await intent('reject')]);
  },
);

it('allows clean multi-group acceptance and refuses bulk wording/text conflicts, even acknowledged', async () => {
  const a = await intent(),
    b = await intent('accept', [44, 45]);
  await put('tooltips/44.json', document(44));
  await put('tooltips/45.json', document(45, 'Different'));
  await expect(
    run([a, { ...b, acknowledgeConflicts: true } as AliasGroupOperation]),
  ).rejects.toMatchObject({ status: 422 });
  await put('tooltips/45.json', document(45));
  items[45] = { ...items[45]!, inGameDescription: 'Different in-game wording' };
  await expect(run([a, await intent('accept', [44, 45])])).rejects.toMatchObject({ status: 422 });
  items[45] = item(45);
  expect(Object.keys((await run([a, await intent('accept', [44, 45])])).config.groups)).toEqual([
    '42',
    '44',
  ]);
  expect(writes).toHaveBeenCalledTimes(1);
});

it.each([
  { categoryId: 'armor-mod' },
  { name: 'Different' },
  { plugCategoryHash: undefined },
  { isEnhanced: true },
  { exotic: true },
])('re-derives eligibility from facts: %j', async (patch) => {
  items[43] = { ...items[43]!, ...patch };
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  expect(writes).not.toHaveBeenCalled();
});

it('requires identical subclass wording and common exotic ownership', async () => {
  for (const hash of [42, 43]) items[hash] = { ...item(hash), categoryId: 'subclass-grenade' };
  items[43]!.inGameDescription = 'Other';
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  for (const hash of [42, 43])
    items[hash] = {
      ...item(hash),
      categoryId: 'weapon-trait-exotic',
      exotic: true,
      owners: [hash],
    };
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  for (const hash of [42, 43]) items[hash]!.owners = [100];
  expect((await run([await intent()])).issues).toEqual([]);
});

it('keeps all earlier archives through canonical changes, and restores authored text archived at the change', async () => {
  await run([await intent()]);
  const first = groups().archives![0]!;
  const edited = document(42, 'Later authored canonical');
  await put('tooltips/42.json', edited);
  const current = files.get('tooltips/42.json');
  await expect(run([{ op: 'setCanonical', canonical: 42, to: 43 }])).rejects.toMatchObject({
    status: 422,
  });
  await run([{ op: 'setCanonical', canonical: 42, to: 43, acknowledgeConflicts: true }]);
  expect(groups().archives).toHaveLength(2);
  expect(groups().archives![0]).toEqual(first);
  expect(read('tooltips/42.json')).toBeNull();
  expect(read('tooltips/43.json')!.value).toEqual(document(43));
  await run([{ op: 'ungroup', canonical: 43 }]);
  expect(files.get('tooltips/42.json')).toBe(current);
  expect(read('tooltips/42.json')!.value).toEqual(edited);
});

it.each([42, 43, 44])(
  'refuses to overwrite a later authored member %s on ungroup',
  async (hash) => {
    await run([await intent('accept', [42, 43, 44])]);
    await put(`tooltips/${hash}.json`, document(hash, 'Later'));
    await expect(run([{ op: 'ungroup', canonical: 42 }])).rejects.toMatchObject({ status: 409 });
    expect(writes).toHaveBeenCalledTimes(1);
  },
);

it('retains archived absence and prior archives through ungroup, reaccept, and split', async () => {
  files.delete('tooltips/43.json');
  await run([await intent()]);
  await run([{ op: 'ungroup', canonical: 42 }]);
  expect(read('tooltips/43.json')).toBeNull();
  await run([await intent('split')]);
  expect(groups().archives).toHaveLength(2);
  await run([{ op: 'ungroup', canonical: 42 }]);
  expect(read('tooltips/43.json')).toBeNull();
});

it('fails closed for corrupt config, missing archives, overlapping operations, and generated aliases', async () => {
  await put(aliasGroupsPath, { version: 2 });
  await expect(run()).rejects.toMatchObject({ status: 502 });
  files.delete(aliasGroupsPath);
  await expect(run([await intent(), await intent('split', [43, 44])])).rejects.toMatchObject({
    status: 422,
  });
  generated = { 43: { to: 42, kind: 'frame' } };
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  generated = {};
  await run([await intent()]);
  const archive = groups().archives![0]!;
  files.delete(`${archive.path.slice(0, -5)}/43.json`);
  await expect(run([{ op: 'ungroup', canonical: 42 }])).rejects.toMatchObject({ status: 409 });
});

it('retargets existing sandbox picks and refuses both sandbox identity collisions', async () => {
  conflicts = { 90: [43, 99] };
  await put('config/sandbox-pointers.json', {
    version: 1,
    pointers: { 90: { to: 43, candidates: [43, 99], by: 1, at: '2026-11-15T00:00:00Z' } },
  });
  expect((await run([await intent()])).affectedCanonicals).toEqual([42, 43]);
  await run([{ op: 'ungroup', canonical: 42 }]);
  for (const hash of [42, 43]) {
    conflicts = { [hash]: [44, 45] };
    await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  }
});

it.each([
  'import main from 43',
  'import main from 60',
  'import main from global',
  'import missing from 61',
])('uses the real resolver to refuse broken canonical imports: %s', async (text) => {
  await put('tooltips/42.json', document(42, text));
  await put('tooltips/60.json', document(60, 'import main from 43'));
  await put('tooltips/1.json', document(1, 'import main from 43'));
  await put('tooltips/61.json', document(61, 'No named export'));
  await expect(
    run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]),
  ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('invalid markup') });
  expect(writes).not.toHaveBeenCalled();
});

it('preserves nested imports and shared titles/variables through the real resolver', async () => {
  await put('tooltips/42.json', document(42, 'import main from 60'));
  await put('tooltips/60.json', document(60, '#hit <title Info [tip] />'));
  await put('tooltips/2.json', document(2, '#hit = 12'));
  await put('tooltips/3.json', document(3, 'title [tip] = Shared title'));
  await run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]);
  const parsed = parseMarkup('import main from 43', {
    imports: { 43: 'import main from 60', 60: '#hit <title Info [tip] />' },
    variables: '#hit = 12',
    titles: 'title [tip] = Shared title',
  });
  expect(parsed.diagnostics.filter((issue) => issue.severity === 'error')).toEqual([]);
});

it('rejects spoofed authority and oversized operation batches', async () => {
  for (const ops of [
    [{ ...(await intent()), bulkEligible: true }],
    Array(101).fill(await intent()),
  ]) {
    await expect(run(ops as AliasGroupOperation[])).rejects.toMatchObject({ status: 400 });
  }
  expect(writes).not.toHaveBeenCalled();
});

it('accepts 100 clean disjoint groups with batched archive reads', async () => {
  const ops: AliasGroupOperation[] = [];
  for (let i = 1000; i < 1200; i += 2) {
    items[i] = item(i);
    items[i + 1] = item(i + 1);
    ops.push(await intent('accept', [i, i + 1]));
  }
  expect(Object.keys((await run(ops)).config.groups)).toHaveLength(100);
  expect(vi.mocked(repo.files).mock.calls.length).toBeLessThan(10);
  expect(writes).toHaveBeenCalledTimes(1);
});

it('keeps the real 2,761-tooltip fixture byte census unchanged across accept and undo', async () => {
  const census = migrateLegacy(database('intermediate'));
  expect(census).toHaveLength(2761);
  for (const entry of census) await put(`tooltips/${entry.hash}.json`, entry);
  const before = new Map([...files].filter(([path]) => path.startsWith('tooltips/')));
  await run([await intent()]);
  await run([{ op: 'ungroup', canonical: 42 }]);
  expect(new Map([...files].filter(([path]) => path.startsWith('tooltips/')))).toEqual(before);
});

it('allows numbered exotic frames only within one proven exotic owner', async () => {
  items[42] = { ...item(42), name: 'Frame', categoryId: 'weapon-frame-exotic', itemHash: 500 };
  items[43] = { ...item(43), name: 'Frame II', categoryId: 'weapon-frame-exotic', itemHash: 501 };
  await expect(run([await intent()])).rejects.toMatchObject({ status: 422 });
  items[43]!.itemHash = 500;
  expect((await run([await intent()])).issues).toEqual([]);
});

it('requires real enhanced base identity and refuses undo that would break enhanced groups', async () => {
  for (const hash of [44, 45])
    items[hash] = {
      ...item(hash),
      categoryId: 'weapon-trait-enhanced',
      isEnhanced: true,
      baseHash: hash - 2,
    };
  await expect(run([await intent('accept', [44, 45])])).rejects.toMatchObject({ status: 422 });
  await run([await intent(), await intent('accept', [44, 45])]);
  await expect(run([{ op: 'ungroup', canonical: 42 }])).rejects.toMatchObject({ status: 422 });
  expect(writes).toHaveBeenCalledTimes(1);
});

it.each(['direct', 'nested', 'title'])(
  'refuses to break an existing %s reader of a removed named export',
  async (kind) => {
    await put('tooltips/43.json', document(43, 'export x (\nExported\n)'));
    await put(
      'tooltips/60.json',
      document(
        60,
        kind === 'direct'
          ? 'import x from 43'
          : kind === 'nested'
            ? 'import main from 61'
            : '<title See [T] />',
      ),
    );
    await put('tooltips/61.json', document(61, 'import x from 43'));
    if (kind === 'title')
      await put('tooltips/3.json', document(3, 'title T (\nimport x from 43\n)'));
    await expect(
      run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]),
    ).rejects.toMatchObject({ status: 422 });
    expect(writes).not.toHaveBeenCalled();
  },
);

it('allows unchanged pre-existing reader diagnostics and keeps named exports when canonical provides them', async () => {
  await put('tooltips/60.json', document(60, 'import missing from 99\nimport main from 43'));
  await run([await intent()]);
  await run([{ op: 'ungroup', canonical: 42 }]);
  const source = 'export x (\nExported\n)';
  await put('tooltips/42.json', document(42, source));
  await put('tooltips/43.json', document(43, source));
  await put('tooltips/60.json', document(60, 'import x from 43'));
  expect((await run([await intent()])).issues).toEqual([]);
});

it('refuses a restoration that creates a cycle with another group', async () => {
  await put('tooltips/43.json', document(43, 'import main from 44'));
  await run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]);
  await put('tooltips/44.json', document(44, 'import main from 43'));
  await run([await intent('accept', [44, 45])]);
  await expect(run([{ op: 'ungroup', canonical: 42 }])).rejects.toMatchObject({ status: 422 });
  expect(read('tooltips/43.json')).toBeNull();
  expect(writes).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  'validates the final restored snapshot in a disjoint batch, accept first: %s',
  async (acceptFirst) => {
    await put('tooltips/43.json', document(43, 'export x (\nExported\n)'));
    await run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]);
    await put('tooltips/44.json', document(44, 'import x from 43'));
    const undo: AliasGroupOperation = { op: 'ungroup', canonical: 42 };
    const accept = await intent('accept', [44, 45]);
    const result = await run(acceptFirst ? [accept, undo] : [undo, accept]);
    expect(result.config.groups[42]).toBeUndefined();
    expect(result.config.groups[44]).toBeDefined();
    expect(read('tooltips/43.json')).not.toBeNull();
  },
);

it('reads synthesized title imports through the existing resolver instrumentation', async () => {
  await put(
    'tooltips/42.json',
    document(42, 'title T (\n#foimport x from 5\nimport x from 5\n)\n<title See [T] />'),
  );
  await put('tooltips/2.json', document(2, 'var foo = import y from 9'));
  await put('tooltips/5.json', document(5, 'export hidden x (\no\n)'));
  await put('tooltips/9.json', document(9, 'export hidden y (\nNine\n)'));
  expect(
    (await run([{ ...(await intent()), acknowledgeConflicts: true } as AliasGroupOperation]))
      .issues,
  ).toEqual([]);
  const source = read('tooltips/42.json')!.value as ReturnType<typeof document>;
  expect(
    parseMarkup(source.text.en!.text, {
      variables: 'var foo = import y from 9',
      titles: '',
      imports: { 5: 'export hidden x (\no\n)', 9: 'export hidden y (\nNine\n)' },
    }).diagnostics.filter((issue) => issue.severity === 'error'),
  ).toEqual([]);
});

it('refuses a branch move during the reader census without retrying the approval', async () => {
  vi.mocked(repo.publishSnapshot).mockImplementation(async () => ({
    head: sha(99),
    tree: sha(99),
    files: [],
    trees: [[]],
  }));
  await expect(run([await intent()])).rejects.toMatchObject({ status: 409 });
  expect(writes).not.toHaveBeenCalled();
});

it.each([45, 90])(
  'checks reader %s when base acceptance recovers an enhanced alias outside the batch',
  async (source) => {
    if (source === 90) generated = { 90: { to: 45, kind: 'sandbox' } };
    for (const hash of [44, 45])
      items[hash] = {
        ...item(hash),
        categoryId: 'weapon-trait-enhanced',
        isEnhanced: true,
        baseHash: 42,
      };
    const exported = 'export x (\nExported\n)';
    await put('tooltips/44.json', document(44));
    await put('tooltips/45.json', document(45, exported));
    await run([
      { ...(await intent('accept', [44, 45])), acknowledgeConflicts: true } as AliasGroupOperation,
    ]);
    expect(read('tooltips/45.json')).toBeNull();

    items[45] = { ...items[45]!, baseHash: 43 };
    await put('tooltips/45.json', document(45, exported));
    await put('tooltips/60.json', document(60, `import x from ${source}`));
    expect((await run()).issues).toContainEqual(
      expect.objectContaining({
        member: 45,
        reason: 'Enhanced member no longer shares the canonical base group',
      }),
    );
    expect(
      parseMarkup(`import x from ${source}`, {
        variables: '',
        titles: '',
        imports: { [source]: exported },
      }).diagnostics,
    ).toEqual([]);
    await expect(run([await intent()])).rejects.toMatchObject({
      status: 422,
      message: 'Tooltip 60 (en) has invalid markup after grouping',
    });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(groups().groups[42]).toBeUndefined();
    expect(read('tooltips/45.json')!.value).toEqual(document(45, exported));
  },
);
