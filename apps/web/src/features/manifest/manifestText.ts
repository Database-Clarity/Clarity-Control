import { useSyncExternalStore } from 'react';
import type { Item } from '../../services/generatorSchema';

/** Sandbox perk hash -> [name, description], as written by scripts/manifest/sandbox-perks.mjs. */
export type SandboxPerkText = Record<string, readonly [name: string, description: string]>;

export interface SandboxPerkLine {
  hash: number;
  /** Empty when Bungie's definition has no display name. */
  name: string;
  description: string;
}

export type ManifestText =
  /** The item's own in-game description. */
  | { kind: 'own'; description: string }
  /** No description of its own: what its linked sandbox perks say, in the item's perk order. */
  | { kind: 'sandbox'; perks: SandboxPerkLine[] }
  /** The fallback is needed, and the bundled perk text has not arrived yet. */
  | { kind: 'loading' }
  /** Neither the item nor any linked sandbox perk has a description. */
  | { kind: 'none'; perkHashes: number[] };

/**
 * The manifest text to show for an entry: its own description, else the descriptions of its
 * sandbox perks (artifact perks, armour mods, and fragments describe themselves only there).
 * Pure: `perks` is `undefined` while the bundled perk text is still loading.
 */
export function manifestText(
  item: Pick<Item, 'inGameDescription' | 'sandboxPerkHashes'> | undefined,
  perks: SandboxPerkText | undefined,
): ManifestText {
  const description = item?.inGameDescription?.trim();
  if (description) return { kind: 'own', description };
  const perkHashes = item?.sandboxPerkHashes ?? [];
  if (!perkHashes.length) return { kind: 'none', perkHashes };
  if (!perks) return { kind: 'loading' };
  const lines: SandboxPerkLine[] = [];
  for (const hash of perkHashes) {
    const text = perks[hash];
    // Several items list one perk twice, and several perks repeat one sentence: show each once.
    if (!text || lines.some((line) => line.hash === hash)) continue;
    lines.push({ hash, name: text[0], description: text[1] });
  }
  return lines.length ? { kind: 'sandbox', perks: lines } : { kind: 'none', perkHashes };
}

/** One line for the collapsed row. */
export function manifestSummary(text: ManifestText): string {
  switch (text.kind) {
    case 'own':
      return text.description.replace(/\s*\n\s*/g, ' ');
    case 'sandbox': {
      // Stat lines ("-10 Grenade") say little: lead with the perks that have real text.
      const worded = text.perks.filter((perk) => perk.description !== perk.name);
      const shown = worded.length ? worded : text.perks;
      return `Sandbox ${text.perks.length === 1 ? 'perk' : 'perks'}: ${shown.map((perk) => perk.description.replace(/\s*\n\s*/g, ' ')).join(' / ')}`;
    }
    case 'loading':
      return 'Loading sandbox perk text…';
    case 'none':
      return 'No manifest description';
  }
}

// ---- the bundled sandbox perk text: one lazy chunk, fetched once, never per entry ----
let loaded: SandboxPerkText | undefined;
let pending: Promise<void> | undefined;
let failed = false;
const listeners = new Set<() => void>();

function valid(value: unknown): value is { perks: SandboxPerkText } {
  const perks = (value as { perks?: unknown } | null)?.perks;
  if (!perks || typeof perks !== 'object') return false;
  for (const entry of Object.values(perks))
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string'
    )
      return false;
  return true;
}

/** Starts the one-off load (idempotent). A failed load leaves the perk text empty. */
export function loadSandboxPerkText(
  source: () => Promise<unknown> = () => import('./sandbox-perks.json').then((m) => m.default),
): Promise<void> {
  pending ??= source()
    .then((value) => {
      if (!valid(value)) throw new Error('Unexpected sandbox perk text');
      loaded = value.perks;
    })
    .catch(() => {
      failed = true;
      loaded = {};
    })
    .then(() => {
      for (const listener of listeners) listener();
    });
  return pending;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The perk text once loaded; `undefined` before. */
export function useSandboxPerkText(): SandboxPerkText | undefined {
  return useSyncExternalStore(
    subscribe,
    () => loaded,
    () => undefined,
  );
}

export const sandboxPerkTextFailed = () => failed;

/** Test seam. */
export function resetSandboxPerkText(perks?: SandboxPerkText) {
  loaded = perks;
  pending = perks ? Promise.resolve() : undefined;
  failed = false;
  for (const listener of listeners) listener();
}
