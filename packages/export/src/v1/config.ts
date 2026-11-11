// Project config, schema 1 (spec section 6): the JSON a project stores in editor-data
// exports/projects/<id>.json. Strict: unknown keys are refused everywhere. The Worker (P3), the
// site (P4), and build-site (P2) all validate with this schema; `migrateConfig` brings an older
// stored config up to the current schema first.
import { z } from 'zod';
import { legacyPresets, type LegacyPreset } from '../legacy.js';
import {
  configLimits,
  configSchemaVersion,
  exportLanguages,
  isLegacyFile,
  isValidId,
  itemKeys,
  shapes,
  styles,
  symbolIds,
} from './vocabulary.js';

export * from './vocabulary.js';

/** `<project>/v<format>/<file>.json`, relative to the site root (also project.ts filePath). */
const urlPath = (projectId: string, fileId: string, formatVersion: number) =>
  `${projectId}/v${formatVersion}/${fileId}.json`;

const id = z
  .string()
  .refine(isValidId, 'Use 2-32 of a-z, 0-9, and -, starting with a letter; not a reserved name');
/** Plain text, at most 64 characters, no control characters. */
const plain = z
  .string()
  .max(configLimits.string)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const categoryId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'Duplicate entries');

const symbolRule = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('keep') }),
  z.strictObject({ mode: z.literal('drop') }),
  z.strictObject({
    mode: z.literal('replace'),
    before: plain.default(''),
    after: plain.default(''),
  }),
]);
export type SymbolRule = z.infer<typeof symbolRule>;

// Own keys are checked on the raw object first: a JSON "__proto__" key is refused, never applied.
const symbolsSchema = z
  .unknown()
  .refine(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => (symbolIds as readonly string[]).includes(key)),
    'Unknown symbol',
  )
  .pipe(z.partialRecord(z.enum(symbolIds), symbolRule));

const titlesRule = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('keep') }),
  z.strictObject({ mode: z.literal('drop') }),
  z.strictObject({ mode: z.literal('inline'), pattern: z.tuple([plain, plain, plain, plain]) }),
]);
const linksRule = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('keep') }),
  z.strictObject({ mode: z.literal('drop') }),
  z.strictObject({ mode: z.literal('replace'), pattern: z.tuple([plain, plain, plain, plain]) }),
]);

export const dataSchema = z.strictObject({
  /** Item categories whose tooltips are included (generator category ids). */
  categories: uniqueList(categoryId, configLimits.categories),
  /** Item categories whose sandbox perks are included. */
  sandboxPerks: uniqueList(categoryId, configLimits.categories),
  frameAliases: z.boolean(),
  languages: uniqueList(z.enum(exportLanguages), exportLanguages.length).refine(
    (list) => list.length > 0,
    'Choose at least one language',
  ),
  keys: uniqueList(z.enum(itemKeys), itemKeys.length),
  /** Include tooltips whose English text is exactly Bungie's own description. */
  bungieIdentical: z.boolean(),
});
export type FileData = z.infer<typeof dataSchema>;

export const formatSchema = z.strictObject({
  symbols: symbolsSchema,
  titles: titlesRule,
  links: linksRule,
  elementTags: z.boolean(),
  spacer: z.enum(['keep', 'drop']),
});
export type FileFormat = z.infer<typeof formatSchema>;

const fileBase = {
  id,
  /** Server-assigned, immutable (spec section 5, "URL ownership"); absent on a file not saved yet. */
  uid: z
    .string()
    .regex(/^[a-z0-9]{8,32}$/)
    .optional(),
  formatVersion: z.literal(1),
};
const styleFile = z.strictObject({
  ...fileBase,
  preset: z.enum(styles),
  shape: z.enum(shapes),
  data: dataSchema,
  format: formatSchema,
});
/** A legacy preset is frozen: it takes no data or format fields (mode-specific fields only). */
const legacyFile = z.strictObject({
  ...fileBase,
  preset: z.enum(legacyPresets),
});
export const fileSchema = z.union([styleFile, legacyFile]).superRefine((file, ctx) => {
  if (!('shape' in file) || file.shape === 'lines') return;
  const keepAt = (path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', path, message: '"keep" is only possible for the lines shape' });
  for (const [symbol, rule] of Object.entries(file.format.symbols)) {
    if (rule?.mode === 'keep') keepAt(['format', 'symbols', symbol]);
  }
  if (file.format.titles.mode === 'keep') keepAt(['format', 'titles']);
  if (file.format.links.mode === 'keep') keepAt(['format', 'links']);
});
export type StyleFile = z.infer<typeof styleFile>;
export type LegacyFile = z.infer<typeof legacyFile>;
export type ExportFile = StyleFile | LegacyFile;

/** Server-owned list of old URLs kept after a format switch, rename, or removal (spec section 5). */
export const retainedSchema = z.strictObject({
  path: z.string().max(128),
  uid: z.string().regex(/^[a-z0-9]{8,32}$/),
  formatVersion: z.literal(1),
  snapshot: fileSchema,
  /** ISO date-time; the URL keeps updating until then. */
  until: z.iso.datetime(),
});

export const configSchema = z
  .strictObject({
    schema: z.literal(configSchemaVersion),
    id,
    name: plain.min(1),
    files: z.array(fileSchema).max(configLimits.files),
    retained: z.array(retainedSchema).max(configLimits.urlSlots).optional(),
  })
  .superRefine((config, ctx) => {
    const ids = config.files.map((file) => file.id);
    ids.forEach((fileId, index) => {
      if (ids.indexOf(fileId) !== index)
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'id'],
          message: 'Duplicate file id',
        });
    });
    const uids = config.files.flatMap((file) => (file.uid ? [file.uid] : []));
    if (new Set(uids).size !== uids.length)
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'Duplicate file uid' });
    const slots = config.files.length + (config.retained?.length ?? 0);
    if (slots > configLimits.urlSlots)
      ctx.addIssue({
        code: 'custom',
        path: ['retained'],
        message: `At most ${configLimits.urlSlots} URLs per project (active files and retained entries)`,
      });
    // A retained entry is the old URL of one of this project's files: its path is the path its
    // snapshot had, and every URL (active or retained) belongs to exactly one entry.
    const paths = new Map<string, string>();
    config.files.forEach((file, index) =>
      paths.set(urlPath(config.id, file.id, file.formatVersion), `files.${index}`),
    );
    (config.retained ?? []).forEach((entry, index) => {
      const at = ['retained', index];
      const own = urlPath(config.id, entry.snapshot.id, entry.formatVersion);
      if (entry.path !== own)
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'path'],
          message: `Retained path must be ${own}`,
        });
      if (entry.snapshot.formatVersion !== entry.formatVersion)
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'snapshot', 'formatVersion'],
          message: 'Snapshot format version differs from the entry',
        });
      if (entry.snapshot.uid !== undefined && entry.snapshot.uid !== entry.uid)
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'snapshot', 'uid'],
          message: 'Snapshot uid differs from the entry',
        });
      if (paths.has(entry.path))
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'path'],
          message: `URL already used by ${paths.get(entry.path)}`,
        });
      else paths.set(entry.path, `retained.${index}`);
    });
    const perUid = new Map<string, number>();
    for (const entry of config.retained ?? [])
      perUid.set(entry.uid, (perUid.get(entry.uid) ?? 0) + 1);
    for (const [uid, count] of perUid)
      if (count > configLimits.retainedPerFile)
        ctx.addIssue({
          code: 'custom',
          path: ['retained'],
          message: `At most ${configLimits.retainedPerFile} retained entries per file (${uid})`,
        });
  });
export type ExportConfig = z.infer<typeof configSchema>;

/**
 * Schema migrations, `n -> n + 1` (spec section 5). Index n migrates a schema-n config to n + 1.
 * Schema 1 is the first, so the list is empty; a future schema 2 adds `migrations[1]`.
 */
export type Migration = (config: Record<string, unknown>) => Record<string, unknown>;
export const migrations: Readonly<Record<number, Migration>> = {};

/**
 * Brings a stored config of any older schema up to `configSchemaVersion` by applying each
 * migration in turn, then validates it. Throws on an unknown or newer schema, a missing
 * migration, or an invalid result. `table` is for tests (defaults to the real migrations).
 */
export function migrateConfig(
  stored: unknown,
  table: Readonly<Record<number, Migration>> = migrations,
  target = configSchemaVersion,
): ExportConfig {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    throw new Error('A config must be a JSON object');
  let config = structuredClone(stored) as Record<string, unknown>;
  if (typeof config.schema !== 'number' || !Number.isInteger(config.schema) || config.schema < 1)
    throw new Error('A config needs a positive integer "schema"');
  let version: number = config.schema;
  if (version > target)
    throw new Error(`Config schema ${version} is newer than this engine (${target})`);
  while (version < target) {
    const migrate = table[version];
    if (!migrate) throw new Error(`No migration from config schema ${version}`);
    config = migrate(config);
    if (config.schema !== version + 1)
      throw new Error(`Migration from schema ${version} must produce schema ${version + 1}`);
    version += 1;
  }
  return target === configSchemaVersion ? configSchema.parse(config) : (config as ExportConfig);
}

/**
 * Checks a change from `previous` (the stored config) to `next` for the server-owned parts
 * (spec sections 4 and 5), before the Worker applies its own role rules and appends retained
 * entries. A URL belongs to the uid that first published it:
 * - the project id never changes;
 * - a uid is never invented; a retained uid comes back only through a maintainer;
 * - a file (with or without a uid) may not take a URL held by another uid, active or retained,
 *   so stripping, swapping, or reusing uids is refused, and a rename must go to an unheld URL;
 * - `retained` is unchanged, except that a maintainer may delete entries.
 * Files missing from `next` are removals (allowed; the Worker retains their URL).
 */
export function immutableChanges(
  previous: ExportConfig,
  next: ExportConfig,
  { maintainer = false }: { maintainer?: boolean } = {},
): string[] {
  const problems: string[] = [];
  if (next.id !== previous.id) problems.push('The project id cannot change');
  const active = new Set(previous.files.flatMap((file) => (file.uid ? [file.uid] : [])));
  const retained = new Set((previous.retained ?? []).map((entry) => entry.uid));
  const owners = new Map<string, string>();
  for (const file of previous.files)
    if (file.uid) owners.set(urlPath(previous.id, file.id, file.formatVersion), file.uid);
  for (const entry of previous.retained ?? []) owners.set(entry.path, entry.uid);
  for (const file of next.files) {
    if (file.uid && !active.has(file.uid)) {
      if (!retained.has(file.uid))
        problems.push(`File ${file.id} has a uid the server did not assign`);
      else if (!maintainer) problems.push(`Only a maintainer can restore file ${file.id}`);
    }
    const path = urlPath(next.id, file.id, file.formatVersion);
    const owner = owners.get(path);
    if (owner !== undefined && owner !== file.uid)
      problems.push(`The URL ${path} belongs to another file`);
  }
  const before = (previous.retained ?? []).map((entry) => JSON.stringify(entry));
  const after = (next.retained ?? []).map((entry) => JSON.stringify(entry));
  const deletionsOnly = after.every((entry) => before.includes(entry));
  if (maintainer ? !deletionsOnly : before.join('\n') !== after.join('\n'))
    problems.push(
      maintainer ? 'Retained URLs can only be deleted' : 'Retained URLs are server-owned',
    );
  return problems;
}

/** Category ids a config names that the catalog lacks: a notice, never a build failure (spec section 5). */
export function unknownCategories(config: ExportConfig, categoryIds: Iterable<string>): string[] {
  const known = new Set(categoryIds);
  const named = config.files.flatMap((file) =>
    isLegacyFile(file) ? [] : [...file.data.categories, ...file.data.sandboxPerks],
  );
  return [...new Set(named)].filter((category) => !known.has(category)).sort();
}

export type { LegacyPreset };
