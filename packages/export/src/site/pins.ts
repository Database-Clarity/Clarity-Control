// Publish pins (spec section 3, "Publish pins"): the exact identity of one legacy deployment,
// written in two phases to the append-only branch `export-pins` by the legacy job only:
//   1. pending/<pinId>.json before the `live` push (everything but liveCommit);
//   2. the `live` deploy commit names the pinId and the converter SHA in its message;
//   3. pins/<liveCommit>.json after the push, and pins/latest.json advanced to it.
// The legacy job promotes a landed pending record at its start; site runs compute the same
// effective pin without writing anything.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitShow, isAncestor, isSha, json, sha256, writeFile } from './util.js';

export type PinOutcome = 'built' | 'carried' | 'frozen';
export type PinFile = {
  name: string;
  sha256: string;
  outcome: PinOutcome;
  /** The converter SHA these bytes were built from. */
  sourceConverterSha: string;
};
export type Pin = {
  pinId: string;
  converterSha: string;
  inputSha256: string;
  manifestVersion: string;
  /** Hashes whose English text equals Bungie's description (the manifest list both jobs use). */
  hashes: number[];
  /** The engine PIN (source SHA of packages/export) that built the files. */
  engine: string;
  generatorSha: string;
  /** Absent in a pending record. */
  liveCommit?: string;
  files: PinFile[];
};

const pinIdPattern = /^[0-9a-f]{40}-[0-9]{1,20}-[0-9]{1,6}$/;
export const isPinId = (value: unknown): value is string =>
  typeof value === 'string' && pinIdPattern.test(value);

/** A rerun of the same converter SHA (even with a changed manifest) is a new pin, never a relabel. */
export function makePinId(converterSha: string, runId: string, attempt: string) {
  const pinId = `${converterSha}-${runId}-${attempt}`;
  if (!isPinId(pinId)) throw new Error(`Bad pin id parts: ${pinId}`);
  return pinId;
}

/** Shape check for a pin read from the branch (it is data from a repo, never trusted blindly). */
export function checkPin(value: unknown, where: string): Pin {
  const pin = value as Pin;
  const ok =
    pin &&
    typeof pin === 'object' &&
    isPinId(pin.pinId) &&
    isSha(pin.converterSha) &&
    pin.pinId.startsWith(pin.converterSha) &&
    /^[0-9a-f]{64}$/.test(pin.inputSha256) &&
    typeof pin.manifestVersion === 'string' &&
    Array.isArray(pin.hashes) &&
    pin.hashes.every((hash) => Number.isSafeInteger(hash)) &&
    typeof pin.engine === 'string' &&
    isSha(pin.generatorSha) &&
    (pin.liveCommit === undefined || isSha(pin.liveCommit)) &&
    Array.isArray(pin.files) &&
    pin.files.every(
      (file) =>
        /^[A-Za-z0-9]+\.json$/.test(file.name) &&
        /^[0-9a-f]{64}$/.test(file.sha256) &&
        ['built', 'carried', 'frozen'].includes(file.outcome) &&
        isSha(file.sourceConverterSha),
    );
  if (!ok) throw new Error(`Malformed pin ${where}`);
  return pin;
}

// --- `live` deploy commits ------------------------------------------------------------------

export function deployMessage(repo: string, converterSha: string, pinId: string | undefined) {
  // The subject stays the one today's deploy action writes, so history reads the same.
  const lines = [
    `Deploying to live from @ ${repo}@${converterSha} 🚀`,
    '',
    `Export-Converter: ${converterSha}`,
  ];
  if (pinId) lines.push(`Export-Pin: ${pinId}`);
  return lines.join('\n') + '\n';
}

export type Deploy = { commit: string; converterSha: string; pinId?: string };

/** Parses a deploy commit message: our trailers, or the subject of today's deploy action. */
export function parseDeployMessage(message: string): Omit<Deploy, 'commit'> | undefined {
  const trailer = /^Export-Converter: ([0-9a-f]{40})$/m.exec(message)?.[1];
  const pinId = /^Export-Pin: (\S+)$/m.exec(message)?.[1];
  const subject = /^Deploying to live from @ \S+@([0-9a-f]{40}) /.exec(message)?.[1];
  const converterSha = trailer ?? subject;
  if (!converterSha) return undefined;
  return isPinId(pinId) ? { converterSha, pinId } : { converterSha };
}

/**
 * The newest deploy on `live` at `head` (first-parent history; other commits on `live`, such as
 * the contributors README update, are skipped).
 */
export function lastDeploy(liveDir: string, head: string): Deploy | undefined {
  const log = git(liveDir, ['log', '--first-parent', '-n', '500', '--format=%H%x00%B%x1e', head]);
  for (const record of log.split('\x1e')) {
    const [commit, message] = record.replace(/^\s+/, '').split('\x00');
    if (!commit || message === undefined) continue;
    const parsed = parseDeployMessage(message);
    if (parsed) return { commit, ...parsed };
  }
  return undefined;
}

// --- reading the pins branch ------------------------------------------------------------------

const readPin = (pinsDir: string, path: string): Pin | undefined => {
  const full = join(pinsDir, path);
  if (!existsSync(full)) return undefined;
  return checkPin(JSON.parse(readFileSync(full, 'utf8')), path);
};

export const pinPaths = {
  pending: (pinId: string) => `pending/${pinId}.json`,
  promoted: (liveCommit: string) => `pins/${liveCommit}.json`,
  latest: 'pins/latest.json',
};

export type EffectivePin = {
  pin: Pin & { liveCommit: string };
  /** `pending`: the landed deploy's record is not promoted yet (a crash between push and write). */
  source: 'promoted' | 'pending';
  /** Promotion the legacy job still has to write (pin, and whether latest.json advances). */
  promote?: { pin: Pin & { liveCommit: string }; advanceLatest: boolean };
};

/**
 * The pin every run builds from (read-only): the newest landed deploy on `live` when its record
 * exists (promoted, or pending with liveCommit filled in from `live`), else pins/latest.json.
 * A pending record whose deploy never landed is ignored. Returns undefined before the first pin.
 */
export function effectivePin(
  pinsDir: string,
  liveDir: string,
  liveHead: string,
): EffectivePin | undefined {
  const latest = readPin(pinsDir, pinPaths.latest);
  if (latest) {
    if (!latest.liveCommit) throw new Error('pins/latest.json has no liveCommit');
    if (!isAncestor(liveDir, latest.liveCommit, liveHead))
      throw new Error(`pins/latest.json (${latest.liveCommit}) is not on live`);
  }
  const landed = lastDeploy(liveDir, liveHead);
  if (landed?.pinId) {
    const promoted = readPin(pinsDir, pinPaths.promoted(landed.commit));
    if (promoted) {
      if (promoted.pinId !== landed.pinId || promoted.liveCommit !== landed.commit)
        throw new Error(`pins/${landed.commit}.json does not match the live commit`);
      const pin = promoted as Pin & { liveCommit: string };
      const advanceLatest = latest?.liveCommit !== landed.commit;
      return {
        pin,
        source: 'promoted',
        promote: advanceLatest ? { pin, advanceLatest } : undefined,
      };
    }
    const pending = readPin(pinsDir, pinPaths.pending(landed.pinId));
    if (pending && (!latest || latest.liveCommit !== landed.commit)) {
      if (pending.liveCommit !== undefined) throw new Error('A pending pin has a liveCommit');
      verifyAgainstLive(liveDir, landed.commit, pending);
      const pin = { ...pending, liveCommit: landed.commit };
      return { pin, source: 'pending', promote: { pin, advanceLatest: true } };
    }
  }
  if (!latest) return undefined;
  return { pin: latest as Pin & { liveCommit: string }, source: 'promoted' };
}

/** The bytes a pin names are the bytes `live` has at its commit (promotion trusts `live` itself). */
export function verifyAgainstLive(liveDir: string, liveCommit: string, pin: Pin) {
  for (const file of pin.files) {
    const bytes = gitShow(liveDir, liveCommit, `descriptions/${file.name}`);
    if (!bytes || sha256(bytes) !== file.sha256)
      throw new Error(`Pin ${pin.pinId}: ${file.name} differs from live ${liveCommit}`);
  }
}

// --- writing the pins branch (legacy job only) ------------------------------------------------

const bot = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

function commitAndPush(pinsDir: string, paths: string[], message: string, branch: string) {
  git(pinsDir, ['add', '--', ...paths]);
  git(pinsDir, [...bot, 'commit', '--quiet', '-m', message]);
  // Never forced: export-pins is append-only (ruleset: no force-push, no deletion).
  git(pinsDir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
}

export function writePending(pinsDir: string, pin: Pin, branch = 'export-pins') {
  if (pin.liveCommit !== undefined) throw new Error('A pending pin has no liveCommit');
  const path = pinPaths.pending(pin.pinId);
  if (existsSync(join(pinsDir, path))) throw new Error(`${path} exists already`);
  writeFile(join(pinsDir, path), json(pin));
  commitAndPush(pinsDir, [path], `Pending pin ${pin.pinId}`, branch);
}

/**
 * Phase 3 (and start-of-run promotion): pins/<liveCommit>.json, then latest.json when it moves
 * forward. latest.json only ever names the current `live` deploy or an ancestor of it.
 */
export function writePromoted(
  pinsDir: string,
  liveDir: string,
  pin: Pin & { liveCommit: string },
  branch = 'export-pins',
) {
  const paths: string[] = [];
  const path = pinPaths.promoted(pin.liveCommit);
  if (!existsSync(join(pinsDir, path))) {
    writeFile(join(pinsDir, path), json(pin));
    paths.push(path);
  }
  const latest = readPin(pinsDir, pinPaths.latest);
  if (
    !latest?.liveCommit ||
    (latest.liveCommit !== pin.liveCommit && isAncestor(liveDir, latest.liveCommit, pin.liveCommit))
  ) {
    writeFile(join(pinsDir, pinPaths.latest), json(pin));
    paths.push(pinPaths.latest);
  }
  if (paths.length)
    commitAndPush(pinsDir, paths, `Pin ${pin.pinId} at live ${pin.liveCommit}`, branch);
}
