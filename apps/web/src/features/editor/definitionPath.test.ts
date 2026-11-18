import { afterEach, describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { useGlobalIdentities } from '../../stores/globalIdentities';
import { definitionPath } from './definitionPath';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' } },
  associated: [],
});
const data = {
  categories: [],
  items: {},
  aliases: {},
  bundle: {
    tooltips: {
      1: tooltip(1, 'export anti_barrier (\nA\n)\n\nexport overload (\nB\nC\n)'),
      2: tooltip(2, '// note\nvar e = x\n\nvar Damage = 10%\nvar Range = 5'),
      3: tooltip(3, 'title G_refill (\nR\n)\n\ntitle G_conegrowth (\nC\n)'),
      42: tooltip(42, 'Text'),
    },
  },
} as unknown as EditorData;

afterEach(() => useGlobalIdentities.setState({ identities: {}, status: 'idle', error: '' }));

describe('definitionPath', () => {
  it('opens the global entry the aggregate line declares, not the first entry of its kind', () => {
    useGlobalIdentities.setState({
      identities: {
        g_damage0001: { kind: 'variables', name: 'Damage', definitions: {} },
        g_range00001: { kind: 'variables', name: 'Range', definitions: {} },
        g_cone000001: { kind: 'titles', name: 'G_conegrowth', definitions: {} },
        g_overload01: { kind: 'exports', name: 'overload', definitions: {} },
      },
      status: 'ready',
    });
    const at = (hash: number, line: number) =>
      definitionPath({ type: 'tooltip', hash, lang: 'en', line }, data, true);
    expect(at(2, 5)).toBe('/globals/g_range00001?lang=en');
    expect(at(2, 4)).toBe('/globals/g_damage0001?lang=en');
    expect(at(3, 5)).toBe('/globals/g_cone000001?lang=en');
    // Find results can land inside a block: the enclosing declaration opens.
    expect(at(1, 7)).toBe('/globals/g_overload01?lang=en');
  });

  it('resolves by name before the catalogue loads, and leaves tooltip targets alone', () => {
    expect(definitionPath({ type: 'tooltip', hash: 3, lang: 'en', line: 1 }, data, true)).toBe(
      '/globals/titles/G_refill?lang=en',
    );
    expect(definitionPath({ type: 'tooltip', hash: 42, lang: 'en', line: 3 }, data, true)).toBe(
      '/t/42?lang=en&line=3&variant=42',
    );
    // Globals off: the aggregates are ordinary tooltips.
    expect(definitionPath({ type: 'tooltip', hash: 2, lang: 'en', line: 4 }, data, false)).toBe(
      '/t/2?lang=en&line=4&variant=2',
    );
  });
});
