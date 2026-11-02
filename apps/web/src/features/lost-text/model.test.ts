import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Tooltip } from '@clarity/core';
import artifact from './lost-text.json';
import {
  artifactSchema,
  canRecover,
  fingerprint,
  recordKey,
  recoveryDraft,
  visibleRecords,
} from './model';
import type { User } from '../../services/api';
import { replaceDraft } from '../../services/save/drafts';
import { useDraftStore } from '../../stores/drafts';

const result = artifactSchema.parse(artifact);
const concussion = result.records.find((r) => r.hash === 1716000303 && r.lang === 'en')!;
const ricochet = result.records.find((r) => r.hash === 1885400500 && r.lang === 'en')!;
const base: Tooltip = {
  hash: 1885400500,
  associated: [],
  text: {
    en: { text: '', updatedBy: 'old', updatedAt: '2026-01-01T00:00:00Z' },
    de: { text: 'Behalten', updatedBy: 'translator', updatedAt: '2026-01-01T00:00:00Z' },
  },
};
const editor: User = { id: 1, login: 'editor', role: 'editor' };
afterEach(() => vi.restoreAllMocks());
describe('lost-tooltip acceptance', () => {
  it('covers Coils without inventing an English loss where saved English is filled', () => {
    const coils = result.records.filter((r) => [689005463, 1687452232].includes(r.hash));
    expect(coils).toHaveLength(3);
    expect(coils.every((r) => r.lang !== 'en')).toBe(true);
    expect(coils.find((r) => r.hash === 689005463 && r.lang === 'es')?.text).toContain('40ms');
  });
  it('pins Concussion to da189e0 and keeps the suspected loss visible', () => {
    expect(concussion.classification).toMatch(/^(human|unclear)$/);
    expect(concussion.lastNonemptyCommit).toMatch(/^da189e0/);
    expect(concussion.clearingCommit).toMatch(/^a9247b819d45/);
  });
  it('pins Ricochet as human with the lost angle condition', () => {
    expect(ricochet.classification).toBe('human');
    expect(ricochet.text).toContain('can ricochet from sharper angles');
  });
  it('creates exactly the historical language text using the History draft path, preserving others', () => {
    const retry = vi.fn();
    useDraftStore.setState({ drafts: {}, hydrated: true, retry });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const next = recoveryDraft(base, ricochet, editor);
    replaceDraft(base, next);
    expect(useDraftStore.getState().drafts[base.hash].next.text.en?.text).toBe(ricochet.text);
    expect(next.text.de).toEqual(base.text.de);
    expect(next.associated).toEqual(base.associated);
    expect(retry).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['translator', 'trial', null] as const)('rejects recovery by %s', (role) => {
    expect(canRecover({ ...editor, role })).toBe(false);
    expect(() => recoveryDraft(base, ricochet, { ...editor, role })).toThrow('Only editors');
  });
  it('never overwrites text already in a draft', () => {
    expect(() =>
      recoveryDraft(
        {
          ...base,
          text: { en: { text: 'My draft', updatedBy: 'me', updatedAt: '2026-01-01T00:00:00Z' } },
        },
        ricochet,
        editor,
      ),
    ).toThrow('now has text');
  });
  it('hides copies by default, supports class filter, and reopens changed clearing history', () => {
    const copy = { ...ricochet, hash: 2, classification: 'manifest-copy' as const };
    const tooltips = { [base.hash]: base, 2: { ...base, hash: 2 } };
    expect(visibleRecords([ricochet, copy], tooltips, {}, false)).toEqual([ricochet]);
    expect(visibleRecords([ricochet, copy], tooltips, {}, true, 'manifest-copy')).toEqual([copy]);
    const decisions = { [recordKey(ricochet)]: fingerprint(ricochet) };
    expect(visibleRecords([ricochet], tooltips, decisions, false)).toEqual([]);
    const changed = { ...ricochet, clearingCommit: 'a'.repeat(40) };
    expect(visibleRecords([changed], tooltips, decisions, false)).toEqual([changed]);
    expect(visibleRecords([ricochet], tooltips, decisions, false, '', true)).toEqual([ricochet]);
  });
});
