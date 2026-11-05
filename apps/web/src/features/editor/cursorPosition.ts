export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

/** A view's caret belongs to its small status boundary, independent of text publication. */
export function createCursorPosition() {
  let current: CursorPosition = { line: 1, column: 1 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(line: number, column: number) {
      if (current.line === line && current.column === column) return;
      current = { line, column };
      for (const listener of listeners) listener();
    },
  };
}

export type CursorPositionStore = ReturnType<typeof createCursorPosition>;
