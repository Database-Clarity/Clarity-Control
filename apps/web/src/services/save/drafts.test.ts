import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  applySavedOverlay,
  clearSavedOverlay,
  overlayServerSkewMs,
} from '../../stores/savedOverlay';
import { acceptSaved, replaceDraft } from './drafts';
import { editorData, english, tooltip } from './fixtures.testSupport';

const initial = useDraftStore.getState();
const retry = vi.fn();
const next = { ...tooltip, text: { en: { ...english, text: 'Mine' } } };
beforeEach(() => {
  clearSavedOverlay();
  retry.mockClear();
  useDraftStore.setState({ ...initial, hydrated: true, retry });
  useDataStore.setState({ data: editorData() });
});

afterEach(() => vi.useRealTimers());
describe('save draft reconciliation', () => {
  it.each([-10, 10])(
    'carries server time for a saved deletion with %i minute browser skew',
    (minutes) => {
      const savedAt = Date.parse('2026-11-01T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(savedAt + minutes * 60 * 1000);
      acceptSaved({}, [], 'deleted', [123], savedAt);
      const stale = { ...editorData().bundle, generatedAt: new Date(savedAt - 1).toISOString() };
      expect(applySavedOverlay(stale).tooltips[123]).toBeUndefined();
      const newer = {
        ...stale,
        generatedAt: new Date(savedAt + overlayServerSkewMs + 1).toISOString(),
      };
      expect(applySavedOverlay(newer)).toBe(newer);
    },
  );
  it('preserves the original dirty base and persists full-tooltip restores', () => {
    replaceDraft(tooltip, next);
    replaceDraft(next, { ...next, associated: [20] });
    expect(useDraftStore.getState().drafts[123].base).toEqual(tooltip);
    expect(useDraftStore.getState().drafts[123].next.associated).toEqual([20]);
    expect(retry).toHaveBeenCalledTimes(2);
    replaceDraft(tooltip, tooltip);
    expect(useDraftStore.getState().drafts).toEqual({});
  });
  it('clears only submitted unchanged drafts and updates the authoritative bundle immediately', () => {
    replaceDraft(tooltip, next);
    const submitted = useDraftStore.getState().drafts;
    replaceDraft({ ...tooltip, hash: 124 }, { ...next, hash: 124 });
    acceptSaved(submitted, [next], 'saved-commit');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['124']);
    expect(useDataStore.getState().data?.bundle.sourceCommit).toBe('saved-commit');
    expect(useDataStore.getState().data?.bundle.tooltips[123]).toEqual(next);
  });
  it('does not clear preexisting local work during an isolated metadata-only save', () => {
    replaceDraft(tooltip, next);
    const drafts = useDraftStore.getState().drafts;
    const snapshot = {
      ...tooltip,
      bungieSnapshot: { description: 'Current', snapshotAt: english.updatedAt },
    };
    acceptSaved({}, [snapshot], 'snapshot-commit');
    expect(useDraftStore.getState().drafts).toEqual(drafts);
    expect(useDataStore.getState().data?.bundle.tooltips[123]).toEqual(snapshot);
  });
  it('retains edits made during an in-flight save and merges remote-only fields into their new base', () => {
    replaceDraft(tooltip, next);
    const submitted = useDraftStore.getState().drafts;
    replaceDraft(tooltip, { ...next, text: { ...next.text, fr: { ...english, text: 'French' } } });
    const saved = { ...next, associated: [20] };
    acceptSaved(submitted, [saved], 'saved');
    const draft = useDraftStore.getState().drafts[123];
    expect(draft.base).toEqual(saved);
    expect(draft.next.text.fr?.text).toBe('French');
    expect(draft.next.associated).toEqual([20]);
  });
  it('rejects incomplete save responses before mutating local data', () => {
    replaceDraft(tooltip, next);
    const submitted = useDraftStore.getState().drafts;
    expect(() => acceptSaved(submitted, [], 'invalid')).toThrow('omitted');
    expect(useDraftStore.getState().drafts).toEqual(submitted);
    expect(useDataStore.getState().data?.bundle.sourceCommit).toBe('base-commit');
  });
  it('accepts a resolved server deletion without silently recreating the tooltip', () => {
    replaceDraft(tooltip, next);
    acceptSaved(useDraftStore.getState().drafts, [], undefined, [123]);
    expect(useDraftStore.getState().drafts).toEqual({});
    expect(useDataStore.getState().data?.bundle.tooltips[123]).toBeUndefined();
  });
});
