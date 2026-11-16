let last: number | undefined;

/** The shell notes each tooltip the editor opens. */
export function noteEditorEntry(hash: number) {
  if (Number.isSafeInteger(hash)) last = hash;
}

/** The tooltip last open in the editor: a Compendium open without `hash` starts on it when it needs review. */
export function lastEditorEntry() {
  return last;
}
