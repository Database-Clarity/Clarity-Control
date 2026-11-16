// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { stampRevisions } from '../../../services/save/enrichers/metadata';
import { queueSources } from '../../queue/sources';
import type { EditorData } from '../../../stores/data';
import type { QueueItem } from '../../queue/model';

it('keeps token text through save enrichment and completes the real translation queue rule', () => {
  const before: Tooltip = {
    hash: 7,
    associated: [],
    text: {
      en: {
        text: 'Damage 5 for 10 seconds.',
        updatedAt: '2026-11-14T00:00:00.000Z',
        updatedBy: 'editor',
      },
    },
  };
  const item: QueueItem = { key: '7:de', hash: 7, lang: 'de', name: 'Example' };
  const context = (tooltip: Tooltip) => ({
    data: { aliases: {}, items: {}, bundle: { tooltips: { 7: tooltip } } } as unknown as EditorData,
    user: { id: 1, login: 'translator', role: 'translator' as const, languages: ['de' as const] },
    decisions: {},
  });
  expect(queueSources.translations.done(context(before))(item, {})).toBe(false);
  const text = 'Schaden #{=1} für #{=2} Sekunden.';
  const saved = stampRevisions(
    before,
    {
      ...before,
      text: {
        ...before.text,
        de: { text, updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 'translator' },
      },
    },
    'translator',
    '2026-11-15T00:00:00.000Z',
  );
  expect(saved.text.de!.text).toBe(text);
  expect(saved.text.de!.sourceUpdatedAt).toBe(before.text.en!.updatedAt);
  expect(queueSources.translations.done(context(saved))(item, {})).toBe(true);
});
