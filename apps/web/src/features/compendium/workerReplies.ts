import { decodeValueNode, encodePrecomputed, encodePrecomputedSteps } from './precomputedCodec';

export interface WorkerReply {
  id: number;
  // Selected-entry replies contain no catalog and can use native structured clone.
  value?: unknown;
  nodes?: unknown[];
  buffer?: ArrayBuffer;
  sizes?: number[];
  root?: number;
  partialRoot?: number;
  error?: string;
}
type Result = { done: false; partial?: unknown } | { done: true; value: unknown };
/** The messages one encoded result posted, without their request id: replayable as is. */
export type EncodedReply = Omit<WorkerReply, 'id'>[];

/** One transferable per result stage; small packets inside it can be decoded lazily. */
export function sendWorkerResult(
  post: (reply: WorkerReply) => void,
  id: number,
  value: unknown,
  partial?: unknown,
) {
  const writer = resultWriter(post, id, partial);
  writer.finish(encodePrecomputed(value, writer.observe));
}

/**
 * Yield the encoder too: a paused main-thread decoder must not hide priority messages.
 * With `capture`, also keep a copy of every posted message, so an unchanged result can be
 * replayed later without encoding it again.
 */
export async function sendWorkerResultYielding(
  post: (reply: WorkerReply) => void,
  id: number,
  value: unknown,
  partial: unknown,
  yieldWork: () => Promise<void>,
  capture?: EncodedReply,
) {
  const writer = resultWriter(post, id, partial, capture);
  const steps = encodePrecomputedSteps(value, writer.observe);
  for (;;) {
    const end = performance.now() + 2;
    let next = steps.next();
    let count = 0;
    while (!next.done && (++count % 32 !== 0 || performance.now() < end)) next = steps.next();
    if (next.done) {
      writer.finish(next.value);
      return;
    }
    await yieldWork();
  }
}

/** Post a captured result again for a new request: the same bytes the receiver decodes. */
export function replayWorkerResult(
  post: (reply: WorkerReply) => void,
  id: number,
  reply: EncodedReply,
) {
  // The capture stays cached: transfer a copy, never the cached buffer itself.
  for (const message of reply) post({ ...message, id, buffer: message.buffer?.slice(0) });
}

function resultWriter(
  post: (reply: WorkerReply) => void,
  id: number,
  partial: unknown,
  capture?: EncodedReply,
) {
  const encoder = new TextEncoder();
  let sent = 0;
  let published = false;
  let packets: Uint8Array[] = [];
  const packet = (nodes: unknown[]) => packets.push(encoder.encode(JSON.stringify(nodes)));
  const publish = (marker: { root: number } | { partialRoot: number }) => {
    const bytes = new Uint8Array(packets.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of packets) {
      bytes.set(part, at);
      at += part.length;
    }
    const message = { buffer: bytes.buffer, sizes: packets.map((part) => part.length), ...marker };
    capture?.push({ ...message, buffer: bytes.buffer.slice(0) });
    post({ id, ...message });
    packets = [];
  };
  const observe = (current: unknown, root: number, nodes: unknown[]) => {
    while (nodes.length - sent >= 128) {
      packet(nodes.slice(sent, sent + 128));
      sent += 128;
    }
    if (!published && partial !== undefined && current === partial) {
      if (sent < nodes.length) packet(nodes.slice(sent));
      sent = nodes.length;
      publish({ partialRoot: root });
      published = true;
    }
  };
  return {
    observe,
    finish(encoded: { nodes: unknown[]; root: number }) {
      if (sent < encoded.nodes.length) packet(encoded.nodes.slice(sent));
      publish({ root: encoded.root });
    },
  };
}

// A single graph node can be a large catalog array/map. Yield inside those
// containers as well as between nodes, rather than hiding a big final decode.
function* largeNode(node: unknown[], read: (id: number) => unknown): Generator<void, unknown> {
  if (node[0] === 0) {
    const value: unknown[] = [];
    for (let i = 1; i < node.length; i++) {
      value.push(read(node[i] as number));
      if (i % 128 === 0) yield;
    }
    return value;
  }
  if (node[0] === 2) {
    const value = new Map<unknown, unknown>();
    for (let i = 1; i < node.length; i += 2) {
      value.set(read(node[i] as number), read(node[i + 1] as number));
      if (i % 256 === 1) yield;
    }
    return value;
  }
  const value: Record<string, unknown> = {};
  for (let i = 1; i < node.length; i += 2) {
    const key = String(read(node[i] as number)),
      entry = read(node[i + 1] as number);
    if (key === '__proto__')
      Object.defineProperty(value, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else value[key] = entry;
    if (i % 256 === 1) yield;
  }
  return value;
}

export function receiveWorkerResult() {
  const values: unknown[] = [];
  const decoder = new TextDecoder();
  const read = (id: number) => values[id];
  function* steps(reply: WorkerReply): Generator<void, Result> {
    if ('value' in reply) return { done: true, value: reply.value };
    function* nodes() {
      if (reply.nodes) yield* reply.nodes;
      if (reply.buffer) {
        const bytes = new Uint8Array(reply.buffer);
        let at = 0;
        for (const size of reply.sizes ?? []) {
          yield* JSON.parse(decoder.decode(bytes.subarray(at, at + size))) as unknown[];
          at += size;
        }
      }
    }
    for (const node of nodes()) {
      values.push(
        Array.isArray(node) && node.length > 256
          ? yield* largeNode(node, read)
          : decodeValueNode(node, read),
      );
      yield;
    }
    if (reply.partialRoot !== undefined) return { done: false, partial: read(reply.partialRoot) };
    return reply.root === undefined ? { done: false } : { done: true, value: read(reply.root) };
  }
  return Object.assign(
    (reply: WorkerReply) => {
      const iterator = steps(reply);
      let next = iterator.next();
      while (!next.done) next = iterator.next();
      return next.value;
    },
    { steps },
  );
}
