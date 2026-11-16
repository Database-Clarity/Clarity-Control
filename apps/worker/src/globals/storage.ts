import type { GitHub } from '../github.js';
import { HttpError } from '../http.js';
import { limits, oid } from './model.js';

export interface GlobalRawFile {
  sha: string;
  bytes: Uint8Array;
}

/** S5 must implement this bounded transport, rather than adapting GitHub.files' parsed
 * values back into bytes. Check upstream blob size and bounded response bytes before
 * decoding/parsing file contents; reject oversized/truncated/non-blob files without a
 * contents-API fallback. All reads are pinned to head. The handler checks these limits
 * again before UTF-8 decoding or JSON parsing. commit uses GitHub's expected-head CAS.
 */
export interface GlobalsStorage {
  readFiles(
    paths: readonly string[],
    head: string,
    maxFileBytes: number,
    maxTotalBytes: number,
  ): Promise<(GlobalRawFile | null)[]>;
  commit: GitHub['commit'];
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readGlobalFiles(
  storage: GlobalsStorage,
  paths: readonly string[],
  head: string,
  maximum = limits.fileBytes,
): Promise<({ sha: string; value: unknown } | null)[]> {
  if (paths.length > limits.causes || maximum > limits.fileBytes)
    throw new HttpError(503, 'Global read exceeds its bounds');
  if (!paths.length) return [];
  const files = await storage.readFiles(paths, head, maximum, limits.fileBytes);
  if (files.length !== paths.length) throw new HttpError(503, 'Invalid global file response');
  let total = 0;
  // Inspect the ENTIRE batch before decoding any file, including claims and list entries.
  for (const file of files) {
    if (!file) continue;
    if (!(file.bytes instanceof Uint8Array) || !oid.safeParse(file.sha).success)
      throw new HttpError(503, 'Invalid global source identity');
    total += file.bytes.byteLength;
    if (file.bytes.byteLength > maximum || total > limits.fileBytes)
      throw new HttpError(503, 'Global metadata exceeds its byte limit');
  }
  return files.map((file) => {
    if (!file) return null;
    try {
      return { sha: file.sha, value: JSON.parse(decoder.decode(file.bytes)) as unknown };
    } catch {
      throw new HttpError(503, 'Sync pending: invalid file encoding or JSON');
    }
  });
}
