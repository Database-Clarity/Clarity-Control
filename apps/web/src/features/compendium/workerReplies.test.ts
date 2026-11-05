import { expect, it } from 'vitest';
import { receiveWorkerResult, sendWorkerResult, type WorkerReply } from './workerReplies';

it('accepts a selected native-clone value without entering the graph decoder', () => {
  const cell = { plain: 'Selected', runs: [{ text: 'Selected', bold: true }] };
  const value = { matches: new Map([[123, cell]]), snapshot: cell, optional: undefined };
  const receive = receiveWorkerResult();
  const steps = receive.steps(structuredClone({ id: 1, value }));
  const result = steps.next();
  expect(result.done).toBe(true);
  expect(result.value).toEqual({ done: true, value });
  if (!result.done || !result.value.done) throw Error('Selected value was not ready');
  const selected = result.value.value as typeof value;
  expect(selected.matches.get(123)).toBe(selected.snapshot);
  expect(Object.hasOwn(selected, 'optional')).toBe(true);
  expect(receive({ id: 2, value: undefined })).toEqual({ done: true, value: undefined });
});

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
  expect(replies).toHaveLength(1);
  expect(replies[0].buffer).toBeInstanceOf(ArrayBuffer);
  expect(replies[0].sizes!.length).toBeGreaterThan(3);
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

it('delivers validated matches before the review model without breaking shared identities', () => {
  const matches = new Map([
    [12, { cell: { plain: 'Styled', runs: [{ text: 'Styled', bold: true }] } }],
  ]);
  const model = {
    matches,
    entries: Array.from({ length: 4000 }, (_, hash) => ({ hash, text: `Review ${hash}` })),
  };
  const receive = receiveWorkerResult();
  let early: unknown;
  let full: typeof model | undefined;
  let chunksAfterEarly = 0;
  sendWorkerResult(
    (reply) => {
      if (early && reply.buffer) chunksAfterEarly++;
      const decoded = receive(structuredClone(reply));
      if (decoded.done) full = decoded.value as typeof model;
      else if ('partial' in decoded) early = decoded.partial;
    },
    8,
    model,
    matches,
  );
  expect(early).toEqual(matches);
  expect(chunksAfterEarly).toBeGreaterThan(0);
  expect(full).toEqual(model);
  expect(full!.matches).toBe(early);
});

it('yields within large containers and preserves prototype-like keys as ordinary data', () => {
  const object = JSON.parse('{"__proto__":{"safe":true}}');
  for (let i = 0; i < 500; i++) object[`field${i}`] = i;
  const value = {
    object,
    list: Array.from({ length: 15000 }, (_, i) => i),
    map: new Map(Array.from({ length: 1000 }, (_, i) => [i, `Value ${i}`])),
  };
  const receiver = receiveWorkerResult();
  let decoded: typeof value | undefined;
  let yields = 0;
  sendWorkerResult(
    (reply) => {
      const steps = receiver.steps(reply);
      let next = steps.next();
      while (!next.done) {
        yields++;
        next = steps.next();
      }
      if (next.value.done) decoded = next.value.value as typeof value;
    },
    9,
    value,
  );
  expect(yields).toBeGreaterThan(15000);
  expect(decoded).toEqual(value);
  expect(Object.getPrototypeOf(decoded!.object)).toBe(Object.prototype);
  expect(Object.hasOwn(decoded!.object, '__proto__')).toBe(true);
});
