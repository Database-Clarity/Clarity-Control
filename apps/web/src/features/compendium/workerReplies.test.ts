import { expect, it } from 'vitest';
import { receiveWorkerResult, sendWorkerResult, type WorkerReply } from './workerReplies';

it('batches rich results while preserving maps, undefined values and shared cell identity', () => {
  const cell = { plain: 'Styled\ncell', runs: [{ text: 'Styled\ncell', bold: true }] };
  const original = {
    matches: new Map([[123, cell]]),
    snapshot: cell,
    optional: undefined,
    rows: Array.from({ length: 4000 }, (_, i) => ({ hash: i, name: `Entry ${i}`, cell })),
  };
  const replies: WorkerReply[] = [];
  sendWorkerResult((reply) => replies.push(structuredClone(reply)), 7, original);
  expect(replies.length).toBeGreaterThan(3);
  expect(replies.every((reply) => !reply.nodes || reply.nodes.length <= 512)).toBe(true);
  const receive = receiveWorkerResult();
  let decoded: typeof original | undefined;
  for (const reply of replies) {
    const result = receive(reply);
    if (result.done) decoded = result.value as typeof original;
  }
  expect(decoded).toEqual(original);
  expect(decoded!.matches.get(123)).toBe(decoded!.snapshot);
  expect(decoded!.rows[3999].cell).toBe(decoded!.snapshot);
  expect(Object.hasOwn(decoded!, 'optional')).toBe(true);
});

it('preserves a JSON __proto__ key as data without changing object prototypes', () => {
  const receive = receiveWorkerResult();
  let value: unknown;
  sendWorkerResult(
    (reply) => {
      const result = receive(reply);
      if (result.done) value = result.value;
    },
    1,
    JSON.parse('{"__proto__":{"field":"data"}}'),
  );
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
});
