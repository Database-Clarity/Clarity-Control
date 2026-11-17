// The export preview (spec sections 3 and 8), free of DOM and Worker globals so tests run it in
// Node: load the snapshot `/_build/status.json` names, verify every file's sha256, import the
// snapshot's own engine (never the app's build), then build samples and whole files with it.
// previewWorker.ts runs this in a Web Worker; full builds only ever run there.
import { showcaseId, showcaseText } from '@clarity/core';
import type * as EngineModule from '@clarity/export';
import type { Catalog, ExportFile, LegacyInput, Plan } from '@clarity/export';
import { snapshotNames, type BuildStatus } from './site';

export type Engine = Pick<
  typeof EngineModule,
  'compile' | 'decodeV1' | 'isLegacyFile' | 'deployedLegacyPresets' | 'legacyFileName'
> & {
  /** The showcase markup the engine builds perk -1 from (engines that export it). */
  showcaseText?: string;
  /** Whether English stands in for a language of a per-language file (engines that export it). */
  standsIn?: (typeof EngineModule)['standsIn'];
};

/** The output of a plan that holds `language` (one per language, or the whole file). */
const outputFor = (plan: Plan, language: string | null) =>
  plan.outputs?.find(
    (output) => language !== null && (output.languages as string[]).includes(language),
  ) ?? plan.outputs?.[0];

export interface PreviewIo {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Imports the snapshot's engine.mjs from its verified source text. */
  importEngine(source: string): Promise<Engine>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** Compressed size (gzip), or null where the platform cannot compress. */
  gzipSize(bytes: Uint8Array): Promise<number | null>;
}

export interface Snapshot {
  status: BuildStatus;
  engine: Engine;
  input: LegacyInput;
  catalog: Catalog;
  identical: (string | number)[];
}

/** A snapshot file that does not match status.json (a deployment while loading, or tampering). */
export class SnapshotMismatch extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true });

async function bytesOf(io: PreviewIo, url: string, init?: RequestInit): Promise<Uint8Array> {
  const response = await io.fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Loads and verifies the snapshot `status` names; refuses a mixed or mismatched set. */
export async function loadSnapshot(
  io: PreviewIo,
  siteUrl: string,
  status: BuildStatus,
): Promise<Snapshot> {
  const files = await Promise.all(
    snapshotNames.map(async (name) => {
      const bytes = await bytesOf(io, `${siteUrl}/_build/${status.buildId}/${name}`);
      if ((await io.sha256(bytes)) !== status.files[name])
        throw new SnapshotMismatch(
          `${name} of build ${status.buildId} does not match /_build/status.json`,
        );
      return [name, decoder.decode(bytes)] as const;
    }),
  );
  const text = Object.fromEntries(files) as Record<(typeof snapshotNames)[number], string>;
  const engine = await io.importEngine(text['engine.mjs']);
  for (const name of ['compile', 'decodeV1', 'isLegacyFile', 'legacyFileName'] as const)
    if (typeof engine[name] !== 'function')
      throw new SnapshotMismatch(`The snapshot engine has no ${name}`);
  return {
    status,
    engine,
    input: JSON.parse(text['input.json']) as LegacyInput,
    catalog: JSON.parse(text['catalog.json']) as Catalog,
    identical: JSON.parse(text['identical.json']) as (string | number)[],
  };
}

/** "Live file": the config still equals a deployed legacy preset, so the preview shows its bytes. */
export const showsLiveFile = (engine: Engine, file: ExportFile) =>
  engine.isLegacyFile(file) && engine.deployedLegacyPresets.includes(file.preset);

/** Where the published copy of a file is. */
export type LiveRef =
  /** A deployed legacy file at the pin's `live` commit (exact-case name). */
  | { kind: 'legacy'; name: string }
  /** A data-site path (`<project>/v1/<file>.json`), checked against the manifest. */
  | { kind: 'site'; path: string; sha256: string };

export type Entries = Record<string, unknown>;

/** A whole file as hash -> entry (v1 files decoded with the snapshot's reference decoder). */
export function entriesOf(engine: Engine, bytes: Uint8Array): Entries {
  const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { descriptions?: unknown }).descriptions) &&
    typeof (parsed as { perks?: unknown }).perks === 'object'
  )
    return engine.decodeV1(parsed as Parameters<Engine['decodeV1']>[0]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('The file is not a JSON object');
  return parsed as Entries;
}

export type SampleResult =
  | {
      kind: 'entry';
      entry: unknown;
      /** The markup the editors wrote (the shown language's, else English). */
      source?: string;
      /** One file per language: the shown language has no text of its own, English stands in. */
      standIn?: boolean;
    }
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; message: string };

/** One language of the published data (the partner Tooltips view). */
export interface Published {
  variables: string;
  titles: string;
  /** Main text per hash (aliases: their canonical's); also the renderer's imports map. */
  texts: Record<string, string>;
  /** Semantic type per hash, for type-conditioned markup. */
  types: Record<string, string>;
}

export interface FileNumbers {
  entries: number;
  raw: number;
  gzip: number | null;
  /** Entries added, removed, or changed against the live file; null without a live file. */
  changed: number | null;
  notices: unknown[];
}

const ownerOf = (input: LegacyInput, hash: string) => {
  const perk = input.perks[hash];
  return perk && 'aliasOf' in perk && perk.aliasKind === 'sandbox' ? String(perk.aliasOf) : hash;
};

/**
 * Why a hash is not in a style file, in the order the compiler's row selection checks it.
 * Only called once the build left it out.
 */
function absentReason(snapshot: Snapshot, file: ExportFile, hash: string): string {
  const { input, catalog, identical } = snapshot;
  const perk = input.perks[hash];
  if (!perk) return 'Not in the published data';
  if (Number(hash) < 50) return 'Reserved globals are never exported';
  if (engineIsLegacy(snapshot, file)) return 'Not in this legacy file';
  if (!('data' in file)) return 'Not in this file';
  const alias = 'aliasOf' in perk ? perk : undefined;
  if (!file.data.bungieIdentical && identical.map(String).includes(hash))
    return 'Text equals Bungie’s own description (Bungie-identical is off)';
  if (alias?.aliasKind === 'frame' && !file.data.frameAliases) return 'Frame aliases are off';
  const category = catalog.items[ownerOf(input, hash)]?.categoryId;
  if (!category) return 'No item category: left out of every new file';
  if (alias?.aliasKind === 'sandbox')
    return file.data.sandboxPerks.includes(category)
      ? 'No text in the chosen languages'
      : `Sandbox perks of ${category} are not chosen`;
  return file.data.categories.includes(category)
    ? 'No text in the chosen languages'
    : `Category ${category} is not chosen`;
}

const engineIsLegacy = (snapshot: Snapshot, file: ExportFile) => snapshot.engine.isLegacyFile(file);

/**
 * The preview: snapshot, live files, and a few cached builds. One instance per Web Worker.
 */
export class Preview {
  private live = new Map<string, Promise<{ bytes: Uint8Array; entries: Entries }>>();
  private builds = new Map<string, Promise<Plan>>();
  private parsed = new Map<string, Entries>();

  constructor(
    private io: PreviewIo,
    readonly snapshot: Snapshot,
    private urls: { site: string; liveRaw: string },
  ) {}

  /** The published copy of a file as entries, verified against the pin or the manifest. */
  async liveEntries(ref: LiveRef): Promise<Entries> {
    return (await this.liveFile(ref)).entries;
  }

  private liveFile(ref: LiveRef): Promise<{ bytes: Uint8Array; entries: Entries }> {
    const key = ref.kind === 'legacy' ? `legacy:${ref.name}` : `site:${ref.path}:${ref.sha256}`;
    let entries = this.live.get(key);
    if (!entries) {
      entries = (async () => {
        const { status, engine } = this.snapshot;
        let url: string;
        let expected: string;
        if (ref.kind === 'legacy') {
          const pinned = status.legacy[ref.name];
          if (!pinned) throw new Error(`The pin names no ${ref.name}`);
          url = `${this.urls.liveRaw}/${status.liveCommit}/descriptions/${ref.name}`;
          expected = pinned.sha256;
        } else {
          url = `${this.urls.site}/${ref.path}`;
          expected = ref.sha256;
        }
        const bytes = await bytesOf(this.io, url);
        if ((await this.io.sha256(bytes)) !== expected)
          throw new SnapshotMismatch(`The published ${url} does not match its recorded sha256`);
        return { bytes, entries: entriesOf(engine, bytes) };
      })();
      entries.catch(() => this.live.delete(key));
      this.live.set(key, entries);
    }
    return entries;
  }

  /** A whole-file build, cached by config (the last four). */
  build(file: ExportFile): Promise<Plan> {
    const key = JSON.stringify(file);
    let build = this.builds.get(key);
    if (!build) {
      const { engine, input, catalog, identical } = this.snapshot;
      build = Promise.resolve().then(() => engine.compile(input, file, { catalog, identical }));
      build.catch(() => this.builds.delete(key));
      this.builds.set(key, build);
      if (this.builds.size > 4) {
        const oldest = this.builds.keys().next().value!;
        this.builds.delete(oldest);
        for (const parsed of this.parsed.keys())
          if (parsed.startsWith(`${oldest}\n`)) this.parsed.delete(parsed);
      }
    }
    return build;
  }

  /** The bytes of the URL that holds `language` (one per language, or the whole file). */
  private async builtBytes(file: ExportFile, language: string | null): Promise<Uint8Array> {
    const plan = await this.build(file);
    return outputFor(plan, language)?.bytes ?? plan.bytes;
  }

  private async builtEntries(file: ExportFile, language: string | null): Promise<Entries> {
    const bytes = await this.builtBytes(file, language);
    const key = `${JSON.stringify(file)}\n${language}`;
    let entries = this.parsed.get(key);
    if (!entries) {
      entries = entriesOf(this.snapshot.engine, bytes);
      this.parsed.set(key, entries);
    }
    return entries;
  }

  /**
   * One entry exactly as the file has it, from the URL that holds `language` when the file is
   * split per language. A style file compiles with a catalog reduced to the sample's owner and
   * its references' owners: every other row is skipped before it is resolved, so a sample costs
   * one row, while resolution (imports, globals) still reads the whole input. The entry equals
   * the whole-file build's (tested). Legacy presets show the live file (deployed presets) or a
   * whole build (clarityV2). The showcase is always built (the include flag only decides whether
   * the published file carries it), so every setting can be tried on it.
   */
  async sample(
    file: ExportFile,
    hash: string,
    liveRef: LiveRef | null,
    language: string | null = null,
  ): Promise<SampleResult> {
    const { engine, input, catalog, identical } = this.snapshot;
    try {
      if (showsLiveFile(engine, file)) {
        if (liveRef?.kind !== 'legacy') return { kind: 'error', message: 'No live file named' };
        const entries = await this.liveEntries(liveRef);
        return hash in entries
          ? { kind: 'entry', entry: entries[hash] }
          : { kind: 'absent', reason: absentReason(this.snapshot, file, hash) };
      }
      if (engine.isLegacyFile(file)) {
        const entries = await this.builtEntries(file, null);
        return hash in entries
          ? { kind: 'entry', entry: entries[hash] }
          : { kind: 'absent', reason: absentReason(this.snapshot, file, hash) };
      }
      if (hash === showcaseId) {
        const plan = engine.compile(
          input,
          { ...file, data: { ...file.data, includeShowcase: true } },
          { catalog: { items: {}, categories: [] } },
        );
        const entry = (outputFor(plan, language)?.expanded ?? plan.expanded)?.[hash];
        return entry
          ? { kind: 'entry', entry, source: engine.showcaseText ?? showcaseText }
          : {
              kind: 'absent',
              reason: 'The pinned engine does not include the feature showcase yet',
            };
      }
      if (!input.perks[hash]) return { kind: 'absent', reason: 'Not in the published data' };
      const items: Record<string, { categoryId: string } | undefined> = {};
      const own = ownerOf(input, hash);
      items[own] = catalog.items[own];
      const perk = input.perks[hash]!;
      const raw = 'aliasOf' in perk ? input.perks[String(perk.aliasOf)] : perk;
      const canonical = raw && !('aliasOf' in raw) ? raw : undefined;
      for (const target of canonical?.associated ?? []) {
        const owner = ownerOf(input, String(target));
        items[owner] = catalog.items[owner];
      }
      const plan = engine.compile(input, file, {
        catalog: { items, categories: catalog.categories },
        identical,
      });
      const entry = (outputFor(plan, language)?.expanded ?? plan.expanded)?.[hash];
      if (!entry) return { kind: 'absent', reason: absentReason(this.snapshot, file, hash) };
      const editor = canonical?.editor as Record<string, { main: string } | undefined> | undefined;
      const text = language ? editor?.[language] : undefined;
      // The pinned engine's own rule (no text of its own, or the 90-day English fallback); the
      // preview does not resolve markup, so non-blank markup counts as text of its own. An engine
      // without the rule predates per-language files, so it has no stand-ins to flag.
      const standIn =
        !!canonical &&
        file.data.languageFiles === 'perLanguage' &&
        language !== null &&
        language !== 'en' &&
        (engine.standsIn?.(canonical, language as never, {
          [language]: text?.main.trim() ? true : undefined,
        }) ??
          false);
      return {
        kind: 'entry',
        entry,
        source: text?.main.trim() && !standIn ? text.main : editor?.en?.main,
        ...(standIn ? { standIn } : {}),
      };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The live file's entry for a hash (for "Diff vs live file"). */
  async liveSample(ref: LiveRef, hash: string): Promise<SampleResult> {
    try {
      const entries = await this.liveEntries(ref);
      return hash in entries
        ? { kind: 'entry', entry: entries[hash] }
        : { kind: 'absent', reason: 'Not in the live file' };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Whole-file numbers from an on-demand full build (spec section 8, the strip); for a file
   * split per language, the numbers of the URL that holds `language`.
   */
  async numbers(
    file: ExportFile,
    liveRef: LiveRef | null,
    language: string | null = null,
  ): Promise<FileNumbers> {
    const { engine } = this.snapshot;
    let bytes: Uint8Array;
    let notices: unknown[] = [];
    let entries: Entries;
    if (showsLiveFile(engine, file)) {
      if (liveRef?.kind !== 'legacy') throw new Error('No live file named');
      ({ bytes, entries } = await this.liveFile(liveRef));
    } else {
      notices = (await this.build(file)).notices;
      bytes = await this.builtBytes(file, language);
      entries = await this.builtEntries(file, language);
    }
    let changed: number | null = null;
    if (liveRef) {
      try {
        const live = await this.liveEntries(liveRef);
        changed = 0;
        for (const hash of new Set([...Object.keys(live), ...Object.keys(entries)]))
          if (JSON.stringify(live[hash]) !== JSON.stringify(entries[hash])) changed += 1;
      } catch {
        changed = null;
      }
    }
    return {
      entries: Object.keys(entries).length,
      raw: bytes.byteLength,
      gzip: await this.io.gzipSize(bytes),
      changed,
      notices,
    };
  }

  /**
   * The published markup of one language (the partner Tooltips view): every hash's main text,
   * aliases resolved to their canonical's, which is also the imports map the renderer needs; and
   * every hash's semantic type (type-conditioned markup such as enhanced parts), an alias's own
   * type replacing its canonical's, exactly as the engine's expandAliases does.
   */
  published(language: string): Published {
    const { perks } = this.snapshot.input;
    const texts: Record<string, string> = {};
    const types: Record<string, string> = {};
    for (const [hash, perk] of Object.entries(perks)) {
      const source = 'aliasOf' in perk ? perks[String(perk.aliasOf)] : perk;
      if (!source || 'aliasOf' in source) continue;
      const editor = source.editor as Record<string, { main: string } | undefined>;
      texts[hash] = editor[language]?.main ?? '';
      const type = (perk as { type?: string }).type ?? source.type;
      if (type !== undefined) types[hash] = type;
    }
    return { variables: texts[2] ?? '', titles: texts[3] ?? '', texts, types };
  }

  /** The bytes a full build makes (G-PREVIEW compares them with build-site's). */
  async bytes(file: ExportFile): Promise<Uint8Array> {
    return (await this.build(file)).bytes;
  }
}
