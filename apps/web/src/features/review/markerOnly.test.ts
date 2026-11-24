import { describe, expect, it } from 'vitest';
import { publishableHash, type Aliases, type Tooltip } from '@clarity/core';
import { pendingTooltips, publishableHashes, sidebarChanges } from './model';
import type { EditorData } from '../../stores/data';

const stamp = { updatedAt: '2026-06-01T00:00:00Z', updatedBy: 'a' };
const tooltip = (hash: number, text = 'English'): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text, ...stamp } },
});

function editor(tooltips: Tooltip[], aliases: Aliases, pushed: Record<number, string>) {
  return {
    items: Object.fromEntries(
      tooltips.map((t) => [t.hash, { hash: t.hash, name: `Tooltip ${t.hash}`, categoryId: 'perk', icon: '' }]),
    ),
    categories: [],
    aliases,
    bundle: {
      tooltips: Object.fromEntries(tooltips.map((t) => [t.hash, t])),
      pushed,
    },
  } as unknown as EditorData;
}

describe('marker-only classification', () => {
  // 10 is an alias of 101: tooltip 101 carries an incoming-alias marker in its digest.
  const aliases: Aliases = { 10: { to: 101, kind: 'frame' } };

  it('separates alias-marker leftovers from content changes and never-pushed tooltips', async () => {
    const left = tooltip(101);
    const edited = tooltip(102, 'Edited after the push');
    const fresh = tooltip(103);
    const pushed = {
      // Pushed before the alias existed: only the marker differs now.
      101: await publishableHash(left),
      // Pushed with other text: a real content change.
      102: await publishableHash(tooltip(102, 'Original')),
    };
    const entries = await pendingTooltips(
      editor([left, edited, fresh], { ...aliases, 11: { to: 102, kind: 'frame' } }, pushed),
    );
    const byHash = Object.fromEntries(entries.map((e) => [e.tooltip.hash, e]));
    expect(byHash[101]).toMatchObject({ markerOnly: true, isNew: false });
    expect(byHash[102]).toMatchObject({ markerOnly: false, isNew: false });
    expect(byHash[103]).toMatchObject({ markerOnly: false, isNew: true });
  });

  it('never calls an entry without incoming aliases marker-only', async () => {
    const plain = tooltip(5);
    const entries = await pendingTooltips(
      editor([plain], {}, { 5: await publishableHash(tooltip(5, 'Other')) }),
    );
    expect(entries[0].markerOnly).toBe(false);
  });

  it('keeps leftovers out of Select page and the sidebar list', async () => {
    const left = tooltip(101);
    const edited = tooltip(102, 'Edited');
    const entries = await pendingTooltips(
      editor([left, edited], aliases, {
        101: await publishableHash(left),
        102: await publishableHash(tooltip(102, 'Original')),
      }),
    );
    expect(publishableHashes(entries)).toEqual([102]);
    expect(sidebarChanges(entries).map((change) => change.hash)).toEqual([102]);
  });
});
