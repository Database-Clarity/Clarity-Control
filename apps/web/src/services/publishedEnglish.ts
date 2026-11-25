import { withoutEnglish } from '@clarity/core';
import type { EditorData } from '../stores/data';

/** Whether the published version has English: the bundle names where saved and published differ. */
export function publishedEnglish(
  data: EditorData,
  hash: number,
  marker = data.bundle.pushed[hash],
): boolean {
  if (marker === undefined) return false;
  // Published by this session, after the bundle was built.
  if (marker !== data.bundle.pushed[hash]) return true;
  const built = (data.tooltipSnapshot ?? data.bundle).tooltips[hash];
  const differs = data.bundle.englishChanged?.includes(hash) ?? false;
  return (!!built && !withoutEnglish(built)) !== differs;
}
