// A JSON value table preserves structural sharing (especially rich cells/snapshots) on the wire.
export function encodePrecomputed(
  value: unknown,
  observe?: (value: unknown, id: number, nodes: unknown[]) => void,
) {
  const nodes: unknown[] = [];
  const ids = new Map<string, number>();
  const objects = new WeakMap<object, number>();
  function complete(value: unknown, id: number) {
    observe?.(value, id, nodes);
    return id;
  }
  function write(value: unknown): number {
    if (value && typeof value === 'object' && objects.has(value))
      return complete(value, objects.get(value)!);
    let node = value === undefined ? [3] : value;
    if (value && typeof value === 'object') {
      node =
        value instanceof Map
          ? [2, ...[...value].flatMap(([key, entry]) => [write(key), write(entry)])]
          : Array.isArray(value)
            ? [0, ...value.map(write)]
            : [1, ...Object.entries(value).flatMap(([key, entry]) => [write(key), write(entry)])];
    }
    const key = JSON.stringify(node);
    const prior = ids.get(key);
    if (prior !== undefined) {
      if (value && typeof value === 'object') objects.set(value, prior);
      return complete(value, prior);
    }
    const id = nodes.length;
    nodes.push(node);
    ids.set(key, id);
    if (value && typeof value === 'object') objects.set(value, id);
    return complete(value, id);
  }
  const root = write(value);
  return { nodes, root };
}

export function decodeValueNode(node: unknown, read: (id: number) => unknown): unknown {
  if (!Array.isArray(node)) return node;
  if (node[0] === 3) return undefined;
  if (node[0] === 0) return node.slice(1).map((ref) => read(ref as number));
  if (node[0] === 2) {
    const value = new Map<unknown, unknown>();
    for (let i = 1; i < node.length; i += 2)
      value.set(read(node[i] as number), read(node[i + 1] as number));
    return value;
  }
  const value: Record<string, unknown> = {};
  for (let i = 1; i < node.length; i += 2) {
    const key = String(read(node[i] as number));
    const entry = read(node[i + 1] as number);
    if (key === '__proto__')
      Object.defineProperty(value, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else value[key] = entry;
  }
  return value;
}
export function decodePrecomputed(nodes: unknown[], root: number): unknown {
  // Encoding is post-order: every reference points to an already decoded value.
  const values: unknown[] = [];
  for (const node of nodes) values.push(decodeValueNode(node, (id) => values[id]));
  return values[root];
}

/**
 * Same value table, with resumable traversal for background worker replies.
 * One step per written value, in encodePrecomputed's post-order: the same nodes,
 * ids, observe calls, and yields. An explicit stack replaces one nested generator
 * per value, whose every yield crossed the whole delegation chain.
 */
export function* encodePrecomputedSteps(
  value: unknown,
  observe?: (value: unknown, id: number, nodes: unknown[]) => void,
): Generator<void, { nodes: unknown[]; root: number }> {
  const nodes: unknown[] = [];
  const ids = new Map<string, number>();
  // A string node's JSON key is injective and starts with a quote, which no other
  // node's key does, so strings can be interned by their own text.
  const strings = new Map<string, number>();
  const objects = new WeakMap<object, number>();
  const intern = (node: unknown) => {
    const table = typeof node === 'string' ? strings : ids;
    const key = typeof node === 'string' ? node : JSON.stringify(node);
    let id = table.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push(node);
      table.set(key, id);
    }
    return id;
  };
  type Frame = {
    value: object;
    fields: unknown[];
    entries: Iterator<unknown>;
    pairs: boolean;
    pending?: { entry: unknown };
  };
  const stack: Frame[] = [];
  let next: unknown = value;
  for (;;) {
    let id: number | undefined;
    if (next && typeof next === 'object') {
      id = objects.get(next);
      if (id === undefined) {
        // Map and array iteration stay live, like the for...of loops they replace;
        // object entries are read once when the object starts.
        const map = next instanceof Map;
        const array = Array.isArray(next);
        stack.push({
          value: next,
          fields: [map ? 2 : array ? 0 : 1],
          entries: map
            ? (next as Map<unknown, unknown>)[Symbol.iterator]()
            : array
              ? (next as unknown[])[Symbol.iterator]()
              : Object.entries(next)[Symbol.iterator](),
          pairs: !array,
        });
      } else {
        observe?.(next, id, nodes);
        yield;
      }
    } else {
      id = intern(next === undefined ? [3] : next);
      observe?.(next, id, nodes);
      yield;
    }
    // Deliver finished values to their containers until one needs another child.
    for (;;) {
      const frame = stack[stack.length - 1];
      if (id !== undefined) {
        if (!frame) return { nodes, root: id };
        frame.fields.push(id);
        id = undefined;
      }
      if (frame.pending) {
        next = frame.pending.entry;
        frame.pending = undefined;
        break;
      }
      const step = frame.entries.next();
      if (!step.done) {
        if (frame.pairs) {
          const [key, entry] = step.value as [unknown, unknown];
          frame.pending = { entry };
          next = key;
        } else next = step.value;
        break;
      }
      stack.pop();
      id = intern(frame.fields);
      objects.set(frame.value, id);
      observe?.(frame.value, id, nodes);
      yield;
    }
  }
}
