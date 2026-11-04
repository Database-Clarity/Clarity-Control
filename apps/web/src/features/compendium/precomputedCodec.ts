// A JSON value table preserves structural sharing (especially rich cells/snapshots) on the wire.
export function encodePrecomputed(value: unknown) {
  const nodes: unknown[] = [];
  const ids = new Map<string, number>();
  const objects = new WeakMap<object, number>();
  function write(value: unknown): number {
    if (value && typeof value === 'object' && objects.has(value)) return objects.get(value)!;
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
      return prior;
    }
    const id = nodes.length;
    nodes.push(node);
    ids.set(key, id);
    if (value && typeof value === 'object') objects.set(value, id);
    return id;
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
