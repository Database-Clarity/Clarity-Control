// The export preview (spec sections 3 and 8), free of DOM and Worker globals so tests run it in
// Node: load the snapshot `/_build/status.json` names, verify every file's sha256, import the
// snapshot's own engine (never the app's build), then build samples and whole files with it.
// previewWorker.ts runs this in a Web Worker; full builds only ever run there.
import { showcaseId } from '@clarity/core';
import type * as EngineModule from '@clarity/export';
import type { Catalog, ExportFile, LegacyInput } from '@clarity/export';
import { snapshotNames, type BuildStatus } from './site';

export type Engine = Pick<
  typeof EngineModule,
  'compile' | 'decodeV1' | 'isLegacyFile' | 'deployedLegacyPresets' | 'legacyFileName'
>;

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
    Array.isArray((parsed as { texts?: unknown }).texts) &&
    typeof (parsed as { items?: unknown }).items === 'object'
  )
    return engine.decodeV1(parsed as Parameters<Engine['decodeV1']>[0]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('The file is not a JSON object');
  return parsed as Entries;
}

export type SampleResult =
  | { kind: 'entry'; entry: unknown }
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
  private builds = new Map<string, Promise<{ bytes: Uint8Array; notices: unknown[] }>>();
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
  build(file: ExportFile): Promise<{ bytes: Uint8Array; notices: unknown[] }> {
    const key = JSON.stringify(file);
    let build = this.builds.get(key);
    if (!build) {
      const { engine, input, catalog, identical } = this.snapshot;
      build = Promise.resolve().then(() => {
        const plan = engine.compile(input, file, { catalog, identical });
        return { bytes: plan.bytes, notices: plan.notices };
      });
      build.catch(() => this.builds.delete(key));
      this.builds.set(key, build);
      if (this.builds.size > 4) {
        const oldest = this.builds.keys().next().value!;
        this.builds.delete(oldest);
        this.parsed.delete(oldest);
      }
    }
    return build;
  }

  private async builtEntries(file: ExportFile): Promise<Entries> {
    const key = JSON.stringify(file);
    const { bytes } = await this.build(file);
    let entries = this.parsed.get(key);
    if (!entries) {
      entries = entriesOf(this.snapshot.engine, bytes);
      this.parsed.set(key, entries);
    }
    return entries;
  }

  /**
   * One entry exactly as the file has it. A style file compiles with a catalog reduced to the
   * sample's owner and its associations' owners: every other row is skipped before it is
   * resolved, so a sample costs one row, while resolution (imports, globals) still reads the
   * whole input. The entry equals the whole-file build's (tested). Legacy presets show the live
   * file (deployed presets) or a whole build (clarityV2).
   */
  async sample(file: ExportFile, hash: string, liveRef: LiveRef | null): Promise<SampleResult> {
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
        const entries = await this.builtEntries(file);
        return hash in entries
          ? { kind: 'entry', entry: entries[hash] }
          : { kind: 'absent', reason: absentReason(this.snapshot, file, hash) };
      }
      if (hash === showcaseId) {
        if (!('data' in file) || !file.data.includeShowcase)
          return { kind: 'absent', reason: 'Feature showcase is off' };
        const plan = engine.compile(input, file, { catalog: { items: {}, categories: [] } });
        const entry = plan.expanded?.[hash];
        return entry
          ? { kind: 'entry', entry }
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
      const canonical = 'aliasOf' in perk ? input.perks[String(perk.aliasOf)] : perk;
      const associated =
        canonical && !('aliasOf' in canonical) ? (canonical.associated ?? []) : ([] as number[]);
      for (const target of associated) {
        const owner = ownerOf(input, String(target));
        items[owner] = catalog.items[owner];
      }
      const plan = engine.compile(input, file, {
        catalog: { items, categories: catalog.categories },
        identical,
      });
      const entry = plan.expanded?.[hash];
      return entry
        ? { kind: 'entry', entry }
        : { kind: 'absent', reason: absentReason(this.snapshot, file, hash) };
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

  /** Whole-file numbers from an on-demand full build (spec section 8, the strip). */
  async numbers(file: ExportFile, liveRef: LiveRef | null): Promise<FileNumbers> {
    const { engine } = this.snapshot;
    let bytes: Uint8Array;
    let notices: unknown[] = [];
    let entries: Entries;
    if (showsLiveFile(engine, file)) {
      if (liveRef?.kind !== 'legacy') throw new Error('No live file named');
      ({ bytes, entries } = await this.liveFile(liveRef));
    } else {
      ({ bytes, notices } = await this.build(file));
      entries = await this.builtEntries(file);
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
