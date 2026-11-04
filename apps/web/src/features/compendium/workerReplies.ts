import { decodeValueNode, encodePrecomputed } from './precomputedCodec';

export interface WorkerReply {
  id: number;
  nodes?: unknown[];
  root?: number;
  error?: string;
}
/** A flattened value graph avoids one large structured clone on the UI thread. */
export function sendWorkerResult(post: (reply: WorkerReply) => void, id: number, value: unknown) {
  const encoded = encodePrecomputed(value);
  for (let at = 0; at < encoded.nodes.length; at += 512)
    post({ id, nodes: encoded.nodes.slice(at, at + 512) });
  post({ id, root: encoded.root });
}

export function receiveWorkerResult() {
  const values: unknown[] = [];
  return (reply: WorkerReply): { done: false } | { done: true; value: unknown } => {
    for (const node of reply.nodes ?? []) values.push(decodeValueNode(node, (id) => values[id]));
    return reply.root === undefined ? { done: false } : { done: true, value: values[reply.root] };
  };
}
