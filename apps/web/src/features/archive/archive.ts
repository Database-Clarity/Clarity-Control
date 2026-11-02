import { languages, type Lang, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { classifyItem } from '../compendium/itemClassification';
import { loadManifestFacts } from '../compendium/manifestFacts';
import triage from '../compendium/owner-triage.json';

const facts = loadManifestFacts();
export const archiveManifestVersion = facts.source.manifestVersion;
export function archiveIdentity(tooltip: Tooltip, data: EditorData) {
  const member = triage.members.find((entry) => entry.hash === tooltip.hash);
  return (
    tooltip.archive?.lastSeen ?? {
      name:
        data.items[tooltip.hash]?.name ??
        facts.items[tooltip.hash]?.inventory?.displayName ??
        member?.name ??
        `Tooltip ${tooltip.hash}`,
      categoryId:
        data.items[tooltip.hash]?.categoryId ??
        member?.categoryId.replace(/^catalog:/, '') ??
        'unknown',
      manifestVersion: archiveManifestVersion,
    }
  );
}
export function inactiveArchiveHashes(data: EditorData): Set<number> {
  const inactive = new Set<number>();
  for (const tooltip of Object.values(data.bundle.tooltips)) {
    const identity = archiveIdentity(tooltip, data);
    const item = data.items[tooltip.hash] ?? {
      hash: tooltip.hash,
      ...identity,
      icon: '',
      inGameDescription: facts.items[tooltip.hash]?.inventory?.description ?? '',
    };
    if (
      classifyItem(item, tooltip)?.categoryId === 'inactive-placeholder' ||
      facts.items[tooltip.hash]?.inventory?.plug?.plugCategoryIdentifier === 'deprecated'
    )
      inactive.add(tooltip.hash);
  }
  return inactive;
}
/** One target draft and a metadata-only source update; source text is never modified. */
export function associateArchive(
  source: Tooltip,
  target: Tooltip,
  selected: readonly Lang[],
  author: string,
  now: string,
) {
  if (!source.archive) throw new Error('Confirm archival before associating a successor.');
  if (source.hash === target.hash) throw new Error('Choose a different hash.');
  const next = structuredClone(target);
  const chosen = languages.filter(
    (lang) => selected.includes(lang) && source.text[lang]?.text.trim(),
  );
  if (!chosen.length) throw new Error('Choose at least one non-empty language.');
  for (const lang of chosen) {
    next.text[lang] = { ...source.text[lang]!, updatedAt: now, updatedBy: author };
  }
  return {
    source: { ...source, archive: { ...source.archive, successor: target.hash } },
    target: next,
  };
}
