/** Exact word insertions + deletions; a replacement counts as one of each. */
export function changedWords(before: string, after: string): number {
  const left = before.match(/\S+/g) ?? [];
  const right = after.match(/\S+/g) ?? [];
  // Linear memory, including unusually long English descriptions. Runs only in a worker.
  const lengths = new Uint32Array(right.length + 1);
  for (const word of left) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j++) {
      const previous = lengths[j]!;
      lengths[j] = word === right[j - 1] ? diagonal + 1 : Math.max(previous, lengths[j - 1]!);
      diagonal = previous;
    }
  }
  return left.length + right.length - 2 * lengths[right.length]!;
}

export interface ChangeRequest {
  hash: number;
  sourceUpdatedAt: string;
  current: string;
}

export type ChangeSize = { count: number } | { error: string };
/** Shared with queue reconstruction; never stores credentials or translation text. */
export const changeSizeMemory = new Map<string, ChangeSize>();

export function changeKey(request: ChangeRequest): string {
  // Include the actual text: markup-only changes can retain the English timestamp.
  return JSON.stringify([request.hash, request.sourceUpdatedAt, request.current]);
}
