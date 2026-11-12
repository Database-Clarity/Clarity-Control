import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { LegacyInput, LegacyPreset } from '../src/index.js';
import { customJsonStringify } from '../src/converter/helpers.js';
import { databaseConverter } from '../src/converter/publisher.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

/** Text files may be checked out with CRLF on Windows; hash them with LF as committed. */
export const textSha256 = (path: URL) => sha256(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));

export const expected = JSON.parse(readFileSync(fixture('legacy-sha256.json'), 'utf8')) as Record<
  'fixture' | 'live' | 'editorData',
  { input: string; inputSha256: string; files: Record<LegacyPreset, string> }
>;

const identical = JSON.parse(readFileSync(fixture('legacy-identical.json'), 'utf8')) as {
  manifestVersion: string;
  live: number[];
  editorData: number[];
};

export const fixtureInputPath = fixture('legacy-input.json');

/** Fixture (iii): every symbol, title, link, weapon section, alias kind, set bonus, math use, import. */
export function fixtureInput(): { input: LegacyInput; inventoryItem: Record<string, unknown> } {
  const input = JSON.parse(readFileSync(fixtureInputPath, 'utf8')) as LegacyInput;
  const { inventoryItem } = JSON.parse(readFileSync(fixture('legacy-manifest.json'), 'utf8'));
  return { input, inventoryItem };
}

/** Input (i): Live-Clarity-Database converter-v2-test 0bd5dae liveDescriptions.json, shared with core's tests. */
export function liveInput(): { bytes: Buffer; input: LegacyInput; identical: number[] } {
  const bytes = readFileSync(new URL('../../core/test/fixtures/live.json', import.meta.url));
  return { bytes, input: JSON.parse(bytes.toString('utf8')), identical: identical.live };
}

/** Input (ii): editor-data 52007db through core exportLegacy (see legacy-sha256.json). */
export function editorDataInput(): { bytes: Buffer; input: LegacyInput; identical: number[] } {
  const bytes = gunzipSync(readFileSync(fixture('editor-data-export-52007db.json.gz')));
  return { bytes, input: JSON.parse(bytes.toString('utf8')), identical: identical.editorData };
}

/**
 * The held converter's own bytes (the vendored copy in src/converter, without the set-bonus
 * rename) for an input. Fixture (iii) holds element-tagged text (`<solar Firesprite />`), which the
 * engine lowers (src/elementTags.ts) before converting, so its files are the held converter's
 * bytes for the LOWERED fixture, the form an author writes by hand (`<solar/>Firesprite`).
 */
export function heldBytes(input: LegacyInput, preset: LegacyPreset, identical: Iterable<string>) {
  return customJsonStringify(databaseConverter(preset, input.perks, new Set(identical)), [
    'stat',
    'multiplier',
    'weaponTypes',
    'classNames',
  ]);
}
