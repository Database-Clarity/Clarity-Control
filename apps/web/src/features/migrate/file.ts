import { maxFileChars, parseSnapshot, type ParseResult, type Snapshot } from './snapshot';

/** Saves a snapshot as a JSON file (the fallback when the window handshake cannot be used). */
export function downloadSnapshot(snapshot: Snapshot, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Reads an exported file; an oversize file is refused from its size, before it is read. */
export async function readSnapshotFile(file: File): Promise<ParseResult> {
  if (file.size > maxFileChars)
    return {
      ok: false,
      message: `The file is too large (${(file.size / 1048576).toFixed(1)} MB, limit ${Math.floor(maxFileChars / 1048576)} MB).`,
    };
  return parseSnapshot(await file.text(), maxFileChars);
}

export const exportName = () => `clarity-drafts-${new Date().toISOString().slice(0, 10)}.json`;
