import { elementTagNames } from '@clarity/core';

export const rowSeparator = '|';

/** Shared display order, independent of the core markup registry. */
export const rowOrder: readonly string[] = [
  'enhanced-arrow',
  'icon:arrow',
  'base-enhanced-pair',
  'pair',
  rowSeparator,
  ...elementTagNames.map((name) => `icon:${name}`),
  rowSeparator,
  'link',
  'title',
  rowSeparator,
  'inline:bold',
  'inline:exotic',
  rowSeparator,
  'pve',
  'pvp',
  rowSeparator,
  ...['primary', 'special', 'heavy'].map((name) => `icon:${name}`),
  rowSeparator,
  ...['barrier', 'overload', 'unstoppable'].map((name) => `icon:${name}`),
  rowSeparator,
  ...['warlock', 'hunter', 'titan'].map((name) => `icon:${name}`),
];

/** Row entries that the suggestion registry names differently. */
const suggestionIds: Record<string, string> = {
  'enhanced-arrow': 'icon:enhanced-arrow',
  'base-enhanced-pair': 'snippet:base-enhanced-pair',
  link: 'tag:link',
  title: 'tag:title',
  'inline:bold': 'tag:bold',
  'inline:exotic': 'tag:exotic',
  pve: 'tag:pve',
  pvp: 'tag:pvp',
  pair: 'snippet:pair',
};

export const suggestionRowOrder = rowOrder
  .filter((id) => id !== rowSeparator)
  .map((id) => suggestionIds[id] ?? id);
