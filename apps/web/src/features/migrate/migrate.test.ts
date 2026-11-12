import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { DraftStorage, Drafts } from '../../services/draftStorage';
import { mergePrefs, mergeSnapshot } from './merge';
import { movedStart } from './moved';
import { type MessageSource, type PostTarget, startReceiver, startSender, stamp } from './protocol';
import {
  maxMessageChars,
  parseSnapshot,
  serializeSnapshot,
  snapshotVersion,
  type Snapshot,
} from './snapshot';
import {
  applySnapshot,
  clearMoved,
  collectSnapshot,
  previewMerge,
  type MigrateIO,
} from './storage';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } },
  associated: [],
});
const draft = (hash: number, text: string, base = 'original') => ({
  base: tooltip(hash, base),
  next: tooltip(hash, text),
});
const snapshot = (buckets: Snapshot['buckets'], prefs: Snapshot['prefs'] = {}): Snapshot => ({
  version: snapshotVersion,
  buckets,
  prefs,
});

function memoryIO(initial: Record<string, Drafts> = {}, prefs: Record<string, string> = {}) {
  const buckets = new Map(Object.entries(initial));
  const writes: string[] = [];
  const store: Record<string, string> = { ...prefs };
  const io: MigrateIO = {
    listBuckets: async () => [...buckets.keys()],
    open: (bucket): DraftStorage => ({
      read: async () => structuredClone(buckets.get(bucket) ?? {}),
      write: async (drafts) => {
        writes.push(bucket);
        buckets.set(bucket, structuredClone(drafts));
      },
    }),
    prefs: {
      get length() {
        return Object.keys(store).length;
      },
      key: (index) => Object.keys(store)[index] ?? null,
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => {
        store[key] = value;
      },
    },
  };
  return { io, buckets, writes, store };
}

describe('merge', () => {
  it('adds new drafts, skips identical ones, and never replaces an existing draft', () => {
    const mine = draft(1, 'mine on new site');
    const outcome = mergeSnapshot(
      { 'tooltips:user:7': { '1': mine, '2': draft(2, 'same') }, tooltips: {} },
      snapshot({
        'tooltips:user:7': {
          '1': draft(1, 'from old site'),
          '2': draft(2, 'same'),
          '3': draft(3, 'new'),
        },
      }),
    );
    expect(outcome.added).toBe(1);
    expect(outcome.identical).toBe(1);
    expect(outcome.writes['tooltips:user:7']!['1']).toEqual(mine);
    expect(outcome.writes['tooltips:user:7']!['3']).toEqual(draft(3, 'new'));
  });

  it('parks an account conflict in the signed-out bucket, where adopt / keep-separate handles it', () => {
    const incoming = draft(1, 'from old site');
    const outcome = mergeSnapshot(
      { 'tooltips:user:7': { '1': draft(1, 'mine') }, tooltips: {} },
      snapshot({ 'tooltips:user:7': { '1': incoming } }),
    );
    expect(outcome.keptSeparate).toBe(1);
    expect(outcome.writes['tooltips']).toEqual({ '1': incoming });
    expect(outcome.writes['tooltips:user:7']).toBeUndefined();
    expect(outcome.unplaced).toEqual({});
    expect(outcome.stored['tooltips:user:7']).toEqual(['1']);
  });

  it('leaves a conflict unplaced when the signed-out slot holds a different draft', () => {
    const outcome = mergeSnapshot(
      { 'tooltips:user:7': { '1': draft(1, 'mine') }, tooltips: { '1': draft(1, 'unowned') } },
      snapshot({ 'tooltips:user:7': { '1': draft(1, 'from old site') } }),
    );
    expect(outcome.writes).toEqual({});
    expect(outcome.unplaced['tooltips:user:7']!['1']).toEqual(draft(1, 'from old site'));
    expect(outcome.stored['tooltips:user:7']).toBeUndefined();
  });

  it('an unowned-bucket conflict is unplaced, never overwritten', () => {
    const outcome = mergeSnapshot(
      { tooltips: { '1': draft(1, 'mine') } },
      snapshot({ tooltips: { '1': draft(1, 'theirs') } }),
    );
    expect(outcome.writes).toEqual({});
    expect(outcome.unplaced['tooltips']).toEqual({ '1': draft(1, 'theirs') });
  });

  it('adds only missing preferences', () => {
    const result = mergePrefs(
      (key) => (key === 'clarity-settings:device:v1' ? '{"theme":"dark"}' : null),
      {
        'clarity-settings:device:v1': '{"theme":"light"}',
        'description-editor-split': '0.4',
      },
    );
    expect(result).toEqual({ writes: { 'description-editor-split': '0.4' }, skipped: 1 });
  });
});

describe('applying a snapshot', () => {
  it('moves drafts and device preferences into an empty browser', async () => {
    const { io, buckets, store } = memoryIO();
    const result = await applySnapshot(
      snapshot(
        { tooltips: { '1': draft(1, 'a') }, 'tooltips:user:7': { '2': draft(2, 'b') } },
        { 'clarity-settings:device:v1': '{"theme":"dark"}', 'description-editor-split': '0.3' },
      ),
      io,
    );
    expect(result.outcome.added).toBe(2);
    expect(result.prefsAdded).toBe(2);
    expect(buckets.get('tooltips')!['1']).toEqual(draft(1, 'a'));
    expect(buckets.get('tooltips:user:7')!['2']).toEqual(draft(2, 'b'));
    expect(store['description-editor-split']).toBe('0.3');
  });

  it('a second import changes nothing and never overwrites what the first stored', async () => {
    const { io, buckets, writes, store } = memoryIO();
    const first = snapshot(
      { 'tooltips:user:7': { '1': draft(1, 'old site v1') } },
      { 'description-editor-split': '0.3' },
    );
    await applySnapshot(first, io);
    // The user keeps editing on the new site, then imports a later snapshot of the old site.
    buckets.set('tooltips:user:7', { '1': draft(1, 'edited on new site') });
    store['description-editor-split'] = '0.5';
    writes.length = 0;
    const second = await applySnapshot(
      snapshot(
        { 'tooltips:user:7': { '1': draft(1, 'old site v2') } },
        { 'description-editor-split': '0.3' },
      ),
      io,
    );
    expect(buckets.get('tooltips:user:7')!['1']).toEqual(draft(1, 'edited on new site'));
    expect(store['description-editor-split']).toBe('0.5');
    expect(second.outcome.keptSeparate).toBe(1);
    expect(buckets.get('tooltips')!['1']).toEqual(draft(1, 'old site v2'));
    // Importing the same snapshot a third time is a no-op.
    writes.length = 0;
    const third = await applySnapshot(
      snapshot({ 'tooltips:user:7': { '1': draft(1, 'old site v2') } }),
      io,
    );
    expect(third.outcome.added + third.outcome.keptSeparate).toBe(0);
    expect(writes).toEqual([]);
  });

  it('the preview writes nothing', async () => {
    const { io, writes } = memoryIO();
    const preview = await previewMerge(snapshot({ tooltips: { '1': draft(1, 'a') } }), io);
    expect(preview.outcome.added).toBe(1);
    expect(writes).toEqual([]);
  });

  it('collects drafts from every bucket and only movable preferences', async () => {
    const { io } = memoryIO(
      { tooltips: { '1': draft(1, 'a') }, 'tooltips:user:7': {}, other: { '9': draft(9, 'x') } },
      {
        'clarity-settings:device:v1': '{}',
        'clarity-editor-session': 'secret-token',
        'clarity-editor-signin-pending': 'x',
      },
    );
    const { snapshot: collected } = await collectSnapshot(io);
    expect(Object.keys(collected.buckets)).toEqual(['tooltips']);
    expect(Object.keys(collected.prefs)).toEqual(['clarity-settings:device:v1']);
  });

  it('clearing removes only confirmed drafts that still equal what was sent', async () => {
    const sent = snapshot({
      'tooltips:user:7': { '1': draft(1, 'a'), '2': draft(2, 'b'), '3': draft(3, 'c') },
    });
    const { io, buckets } = memoryIO({
      'tooltips:user:7': {
        '1': draft(1, 'a'),
        '2': draft(2, 'edited since'),
        '3': draft(3, 'c'),
        '4': draft(4, 'unsent'),
      },
    });
    const removed = await clearMoved(sent, { 'tooltips:user:7': ['1', '1', '2'] }, io);
    expect(removed).toBe(1);
    expect(await clearMoved(sent, { 'tooltips:user:7': ['1', '1', '2'] }, io)).toBe(0);
    expect(Object.keys(buckets.get('tooltips:user:7')!).sort()).toEqual(['2', '3', '4']);
  });

  it('clearing ignores inherited property names such as constructor', async () => {
    const sent = snapshot({ 'tooltips:user:7': { '1': draft(1, 'a') } });
    const { io } = memoryIO({ 'tooltips:user:7': { '1': draft(1, 'a') } });
    expect(await clearMoved(sent, { 'tooltips:user:7': ['constructor', 'toString'] }, io)).toBe(0);
  });
});

describe('snapshot parsing', () => {
  it('refuses oversize text with a message, before parsing', () => {
    const result = parseSnapshot('x'.repeat(100), 50);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain('too large');
    expect(!result.ok && result.message).toContain('Export file');
  });

  it('drops unsafe preference keys and rejects bad buckets or drafts', () => {
    const ok = parseSnapshot(
      JSON.stringify(
        snapshot({}, { 'clarity-editor-session': 'token', 'clarity-settings:device:v1': '{}' }),
      ),
      maxMessageChars,
    );
    expect(ok.ok && Object.keys(ok.snapshot.prefs)).toEqual(['clarity-settings:device:v1']);
    expect(
      parseSnapshot(JSON.stringify(snapshot({ 'not-a-bucket': {} })), maxMessageChars).ok,
    ).toBe(false);
    expect(
      parseSnapshot(
        JSON.stringify(snapshot({ tooltips: { '5': draft(1, 'mismatch') } })),
        maxMessageChars,
      ).ok,
    ).toBe(false);
    expect(parseSnapshot('{not json', maxMessageChars).ok).toBe(false);
    expect(parseSnapshot(42, maxMessageChars).ok).toBe(false);
  });

  it('serializing an over-cap snapshot is refused', () => {
    expect(serializeSnapshot(snapshot({ tooltips: { '1': draft(1, 'a') } }), 100).ok).toBe(false);
    expect(serializeSnapshot(snapshot({}), 1000).ok).toBe(true);
  });
});

const oldOrigin = 'https://old.example';
const newOrigin = 'https://new.example';
function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: { message: Record<string, unknown>; origin: string }[] = [];
  const target: PostTarget & MessageSource = {
    closed: false,
    postMessage: (message, origin) =>
      posted.push({ message: message as Record<string, unknown>, origin }),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const deliver = (source: unknown, origin: string, data: unknown) =>
    listeners.forEach((listener) => listener({ source, origin, data } as unknown as MessageEvent));
  return { target, posted, deliver, listeners };
}

describe('receiver handshake (new site)', () => {
  const setup = (maxChars?: number) => {
    const page = fakeWindow();
    const opener = fakeWindow();
    const events: string[] = [];
    let received: Snapshot | undefined;
    const receiver = startReceiver(
      page.target,
      opener.target,
      [oldOrigin],
      {
        onSnapshot: (value) => ((received = value), events.push('snapshot')),
        onRefused: (message) => events.push(`refused:${message}`),
        onAbort: (reason) => events.push(`abort:${reason}`),
      },
      maxChars,
    );
    const send = (source: unknown, origin: string, payload: string) =>
      page.deliver(source, origin, { ...stamp, type: 'snapshot', payload });
    return { page, opener, events, receiver, send, received: () => received };
  };
  const valid = JSON.stringify(snapshot({ tooltips: { '1': draft(1, 'a') } }));

  it('announces itself to the allowed sender origin only', () => {
    const { opener } = setup();
    expect(opener.posted).toEqual([{ message: { ...stamp, type: 'ready' }, origin: oldOrigin }]);
  });

  it('accepts a snapshot from the opener at the exact allowed origin', () => {
    const { opener, send, events, received } = setup();
    send(opener.target, oldOrigin, valid);
    expect(events).toEqual(['snapshot']);
    expect(received()!.buckets['tooltips']).toBeDefined();
  });

  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['a look-alike origin', 'https://old.example.evil'],
    ['http instead of https', 'http://old.example'],
    ['the allowed origin with a path', 'https://old.example/'],
  ])('ignores a snapshot from %s', (_name, origin) => {
    const { opener, send, events } = setup();
    send(opener.target, origin, valid);
    expect(events).toEqual([]);
  });

  it('ignores a snapshot from a window that is not the opener, even at the right origin', () => {
    const { send, events } = setup();
    send(fakeWindow().target, oldOrigin, valid);
    send(null, oldOrigin, valid);
    expect(events).toEqual([]);
  });

  it('refuses an oversize payload with a message and tells the sender', () => {
    const { opener, send, events } = setup(100);
    send(opener.target, oldOrigin, 'x'.repeat(101));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^refused:The data is too large/);
    expect(opener.posted.at(-1)).toMatchObject({
      message: { type: 'refused' },
      origin: oldOrigin,
    });
  });

  it('ignores malformed messages and handles an abort from the sender', () => {
    const { opener, page, events } = setup();
    page.deliver(opener.target, oldOrigin, 'hello');
    page.deliver(opener.target, oldOrigin, { type: 'snapshot', payload: valid });
    page.deliver(opener.target, oldOrigin, { ...stamp, type: 'abort', reason: 'too big' });
    expect(events).toEqual(['abort:too big']);
  });

  it('replies only to the sender origin, never to a closed window, and stops listening', () => {
    const { opener, send, receiver, page } = setup();
    receiver.reply({ type: 'early' });
    expect(opener.posted.filter((entry) => entry.message.type === 'early')).toHaveLength(0);
    send(opener.target, oldOrigin, valid);
    receiver.reply({ type: 'done' });
    expect(opener.posted.at(-1)).toEqual({ message: { type: 'done' }, origin: oldOrigin });
    opener.target.closed = true;
    receiver.reply({ type: 'late' });
    expect(opener.posted.some((entry) => entry.message.type === 'late')).toBe(false);
    receiver.stop();
    expect(page.listeners.size).toBe(0);
  });

  it('is inert without an opener: nothing is sent, nothing is accepted', () => {
    const page = fakeWindow();
    const events: string[] = [];
    startReceiver(page.target, null, [oldOrigin], {
      onSnapshot: () => events.push('snapshot'),
      onRefused: () => events.push('refused'),
      onAbort: () => events.push('abort'),
    });
    page.deliver(null, oldOrigin, { ...stamp, type: 'snapshot', payload: valid });
    expect(events).toEqual([]);
  });
});

describe('sender handshake (old site)', () => {
  const setup = (payload: Promise<string>) => {
    const page = fakeWindow();
    const popup = fakeWindow();
    const events: string[] = [];
    const sender = startSender(page.target, popup.target, newOrigin, payload, {
      onWaiting: () => events.push('waiting'),
      onSent: () => events.push('sent'),
      onDone: (stored, unplaced) => events.push(`done:${JSON.stringify(stored)}:${unplaced}`),
      onRefused: (reason) => events.push(`refused:${reason}`),
      onClosed: () => events.push('closed'),
    });
    const ready = { ...stamp, type: 'ready' };
    return { page, popup, events, sender, ready };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('sends the snapshot only after a ready from the opened window at the exact new origin', async () => {
    const { page, popup, events, ready } = setup(Promise.resolve('{"payload":1}'));
    page.deliver(popup.target, 'https://evil.example', ready);
    page.deliver(fakeWindow().target, newOrigin, ready);
    await flush();
    expect(popup.posted).toEqual([]);
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    expect(popup.posted).toEqual([
      { message: { ...stamp, type: 'snapshot', payload: '{"payload":1}' }, origin: newOrigin },
    ]);
    expect(events).toEqual(['waiting', 'sent']);
  });

  it('sends only once for repeated ready messages', async () => {
    const { page, popup, ready } = setup(Promise.resolve('{}'));
    page.deliver(popup.target, newOrigin, ready);
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    expect(popup.posted).toHaveLength(1);
  });

  it('tells the receiver and the user when the snapshot is over the cap', async () => {
    const { page, popup, events, ready } = setup(
      Promise.reject(new Error('Too large. Use Export file.')),
    );
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    expect(popup.posted.map((entry) => entry.message.type)).toEqual(['abort']);
    expect(events).toEqual(['waiting', 'refused:Too large. Use Export file.']);
  });

  it('reports done from the new origin only, and a closed window while waiting', async () => {
    const { page, popup, events, sender, ready } = setup(Promise.resolve('{}'));
    const done = { ...stamp, type: 'done', stored: { tooltips: ['1'] }, unplaced: 0 };
    page.deliver(popup.target, 'https://evil.example', done);
    expect(events).toEqual(['waiting']);
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    page.deliver(popup.target, newOrigin, done);
    expect(events.at(-1)).toBe('done:{"tooltips":["1"]}:0');
    expect(sender.checkClosed()).toBe(false);

    const waiting = setup(Promise.resolve('{}'));
    waiting.popup.target.closed = true;
    expect(waiting.sender.checkClosed()).toBe(true);
    expect(waiting.events).toEqual(['waiting', 'closed']);
  });

  it('keeps refusal on close and lets the user retry after the receiver refuses', async () => {
    const { page, popup, events, ready, sender } = setup(Promise.resolve('{}'));
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    page.deliver(popup.target, newOrigin, { ...stamp, type: 'refused', reason: 'nope' });
    popup.target.closed = true;
    expect(sender.checkClosed()).toBe(true);
    expect(events.at(-1)).toBe('refused:nope');
    popup.target.closed = false;
    expect(events.at(-1)).toBe('refused:nope');
    page.deliver(popup.target, newOrigin, ready);
    await flush();
    expect(popup.posted).toHaveLength(2);
  });
});

describe('moved page start', () => {
  it('redirects only when nothing is readable AND nothing is unreadable', () => {
    expect(movedStart({ snapshot: snapshot({}), unreadable: [] })).toEqual({ kind: 'redirect' });
    expect(movedStart({ snapshot: snapshot({}), unreadable: ['tooltips'] })).toEqual({
      kind: 'unreadable',
    });
    expect(
      movedStart({ snapshot: snapshot({ tooltips: { '1': draft(1, 'a') } }), unreadable: [] }),
    ).toEqual({ kind: 'idle', drafts: 1 });
    expect(
      movedStart({
        snapshot: snapshot({ tooltips: { '1': draft(1, 'a') } }),
        unreadable: ['tooltips:user:7'],
      }),
    ).toEqual({ kind: 'idle', drafts: 1 });
  });

  it('collectSnapshot reports a bucket that fails validation as unreadable', async () => {
    const { io } = memoryIO({ tooltips: { '1': draft(1, 'a') } });
    const broken: MigrateIO = {
      ...io,
      open: () => ({
        read: async () => Promise.reject(new Error('Stored drafts are invalid')),
        write: async () => undefined,
      }),
    };
    const collected = await collectSnapshot(broken);
    expect(collected.unreadable).toEqual(['tooltips']);
    expect(movedStart(collected)).toEqual({ kind: 'unreadable' });
  });
});
