import { describe, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import {
  computeDiagnostics,
  type DiagnosticInput,
  type DiagnosticResult,
} from './diagnosticRequest';
import { diagnosticGlobals, requestDiagnostics } from './diagnosticWorker';

describe('worker diagnostic snapshots', () => {
  it('preserves validation across nested/global/missing/cyclic imports and declaration types', () => {
    const globals: MarkupGlobals = {
      variables: 'var damage = 5',
      titles: 'title Detail (\n#damage\n)',
      imports: {
        1: 'export nested (\nimport main from 42\n)',
        42: 'var local = 7\nimport main from 43\n#local',
        43: '<title Label [Detail] />',
        44: 'import main from 45',
        45: 'import main from 44',
        99: 'unused',
      },
    };
    for (const text of [
      '',
      '#damage',
      '#missing',
      'import nested from global',
      'import main from 999',
      'import main from 44',
      'import self',
      'enhanced (\n#missing\n)',
      '<<<<<<< mine\n#damage\n=======\n#missing\n>>>>>>> theirs',
      'plain\u200b text',
    ])
      for (const type of [undefined, 'Weapon Trait', 'Weapon Trait Enhanced'])
        for (const lang of ['en', 'de'] as const)
          for (const selfHash of [2, 10]) {
            const full = { ...globals, type };
            const input = { text, lang, globals: full, requireEnglish: true, selfHash };
            expect(
              computeDiagnostics({ ...input, globals: diagnosticGlobals(text, full) }),
            ).toEqual(computeDiagnostics(input));
          }
  });

  it('reads only reachable dependencies and invalidates when a transitive source changes', () => {
    const imports: Record<string, string> = {
      42: 'import main from 43',
      43: '#missing',
      99: 'unused',
    };
    const lazy = new Proxy(imports, {
      ownKeys() {
        throw new Error('Do not enumerate the catalogue');
      },
    });
    const globals = { variables: '', titles: '', imports: lazy };
    const first = diagnosticGlobals('import main from 42', globals);
    expect(Object.keys(first.imports!)).toEqual(['42', '43']);
    imports[99] = 'unrelated edit';
    expect(diagnosticGlobals('import main from 42', globals)).toBe(first);
    imports[43] = 'resolved';
    const changed = diagnosticGlobals('import main from 42', globals);
    expect(changed).not.toBe(first);
    expect(changed.imports?.[43]).toBe('resolved');
    expect(first.imports?.[43]).toBe('#missing');
    expect(diagnosticGlobals('ordinary typing', globals).imports).toEqual({});
  });

  it('shares the status and decoration worker request for the same effective input', async () => {
    const messages: { id: number; input: DiagnosticInput }[] = [];
    const instances: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent<{ id: number; result: DiagnosticResult }>) => void) | null =
        null;
      onerror: (() => void) | null = null;
      constructor() {
        instances.push(this);
      }
      postMessage(message: { id: number; input: DiagnosticInput }) {
        messages.push(message);
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const input: DiagnosticInput = {
        text: '#missing',
        lang: 'en',
        globals: { variables: '', titles: '' },
        requireEnglish: true,
        selfHash: 71,
      };
      const first = requestDiagnostics(input);
      const second = requestDiagnostics({
        ...input,
        globals: { ...input.globals, imports: { 99: 'unrelated' } },
      });
      expect(second).toBe(first);
      expect(messages).toHaveLength(1);
      const expected = computeDiagnostics(input);
      instances[0].onmessage!({ data: { id: messages[0].id, result: expected } } as MessageEvent);
      expect(await first).toEqual(expected);
      expect(await second).toEqual(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
