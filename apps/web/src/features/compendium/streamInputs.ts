// Input models are JSON data. Bound serialization and transfer work so even a large
// fixture/reloaded editor cannot become one main-thread structured-clone task.
function* tokens(value: unknown, inArray = false): Generator<string> {
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      yield* tokens(value[index], true);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    // Catalog items and translation records are flat JSON objects. Let the
    // native serializer handle each record instead of yielding every punctuation
    // token; keep the surrounding model incremental and interruptible.
    if (
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      entries.every(
        ([key, entry]) => (entry === null || typeof entry !== 'object') && key !== 'toJSON',
      )
    ) {
      yield JSON.stringify(value);
      return;
    }
    yield '{';
    let comma = false;
    for (const [key, entry] of entries) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      if (comma) yield ',';
      comma = true;
      yield JSON.stringify(key);
      yield ':';
      yield* tokens(entry);
    }
    yield '}';
  } else {
    const text = JSON.stringify(value);
    if (text !== undefined) yield text;
    else if (inArray) yield 'null';
  }
}
function yieldTask() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
export async function streamInputs(
  value: unknown,
  send: (bytes: ArrayBuffer) => void,
  cancelled: () => boolean,
) {
  const encoder = new TextEncoder();
  let parts: string[] = [];
  let length = 0;
  let count = 0;
  let deadline = performance.now() + 2;
  const flush = () => {
    if (cancelled()) throw new Error('Compendium inputs changed.');
    if (parts.length) {
      const bytes = encoder.encode(parts.join(''));
      for (let at = 0; at < bytes.length; at += 32_768) {
        if (cancelled()) throw new Error('Compendium inputs changed.');
        send(bytes.slice(at, at + 32_768).buffer as ArrayBuffer);
      }
    }
    parts = [];
    length = 0;
  };
  for (const token of tokens(value)) {
    parts.push(token);
    length += token.length;
    if (length >= 32_768 || (++count % 64 === 0 && performance.now() >= deadline)) {
      flush();
      await yieldTask();
      deadline = performance.now() + 2;
    }
  }
  flush();
}
