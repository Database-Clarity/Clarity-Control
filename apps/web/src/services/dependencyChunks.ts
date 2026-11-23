interface Dependent {
  hash: number;
  dependencies?: readonly number[];
}

interface ChunkLimits<T> {
  fits(items: readonly T[]): boolean;
  splitDependencies?: boolean | ((items: readonly T[]) => boolean);
  order?(a: T, b: T): number;
  missing(hash: number): string;
  duplicate: string;
}

/** Keep not-yet-emitted dependencies together. With a hard limit, try dependencies first
 * when a closure won't fit; a strongly connected group still needs one request. */
export function dependencyChunks<T extends Dependent>(
  inputs: readonly T[],
  limits: ChunkLimits<T>,
): T[][] {
  const byHash = new Map(inputs.map((input) => [input.hash, input]));
  if (byHash.size !== inputs.length) throw new Error(limits.duplicate);
  const emitted = new Set<number>();
  const chunks: T[][] = [];
  let chunk: T[] = [];

  function collect(root: number) {
    const closure = new Map<number, T>();
    const finished: number[] = [];
    function visit(hash: number) {
      if (emitted.has(hash) || closure.has(hash)) return;
      const item = byHash.get(hash);
      if (!item) throw new Error(limits.missing(hash));
      closure.set(hash, item);
      for (const dependency of item.dependencies ?? []) visit(dependency);
      finished.push(hash);
    }
    visit(root);
    return { items: [...closure.values()], finished };
  }

  function append(items: T[]) {
    if (chunk.length && !limits.fits([...chunk, ...items])) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...items);
    for (const { hash } of items) emitted.add(hash);
  }

  for (const { hash } of [...inputs].sort(limits.order ?? ((a, b) => a.hash - b.hash))) {
    const closure = collect(hash);
    if (!closure.items.length) continue;
    const split =
      typeof limits.splitDependencies === 'function'
        ? limits.splitDependencies(closure.items)
        : limits.splitDependencies;
    if (!split || limits.fits(closure.items)) append(closure.items);
    else {
      // Walk the reversed edges in reverse finish order to find each cycle independently.
      // A dependency outside a cycle must be able to publish before it.
      const readers = new Map(closure.items.map((item) => [item.hash, [] as T[]]));
      for (const item of closure.items)
        for (const dependency of item.dependencies ?? []) readers.get(dependency)?.push(item);

      const seen = new Set<number>();
      const groups: T[][] = [];
      for (const hash of closure.finished.reverse()) {
        if (seen.has(hash)) continue;
        const group: T[] = [];
        const pending = [byHash.get(hash)!];
        while (pending.length) {
          const item = pending.pop()!;
          if (seen.has(item.hash)) continue;
          seen.add(item.hash);
          group.push(item);
          pending.push(...readers.get(item.hash)!);
        }
        groups.push(group);
      }
      for (const group of groups.reverse()) append(group);
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
