import {
  globalsInPlaceCapability,
  globalsInPlaceClearance,
  globalsInPlaceFenceSchema,
  globalsInPlaceLibraryText,
  globalsInPlaceSaveIssue,
  type Tooltip,
} from '@clarity/core';
import { HttpError } from '../http.js';

export function inPlaceAdmission(
  raw: unknown,
  pin: unknown,
  hashes: Iterable<number>,
  destination: string,
) {
  if (raw === undefined) return undefined;
  const fence = globalsInPlaceFenceSchema.safeParse(raw);
  if (
    !fence.success ||
    !globalsInPlaceClearance(fence.data) ||
    fence.data.destination !== destination
  )
    throw new HttpError(409, 'Publication is paused for the shared text migration.');
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes(globalsInPlaceCapability))
    throw new HttpError(409, 'Update the installed publisher before publishing shared text.');
  if ([...hashes].some((hash) => globalsInPlaceLibraryText(hash) !== undefined))
    throw new HttpError(
      422,
      'Shared definitions publish with their tooltips. Review the affected tooltip instead.',
    );
  return fence.data;
}

export function refuseInPlaceSave(
  tooltip: Pick<Tooltip, 'hash'> & {
    text: Partial<Record<keyof Tooltip['text'], { text: string }>>;
  },
) {
  if (globalsInPlaceLibraryText(tooltip.hash) !== undefined) return;
  for (const cell of Object.values(tooltip.text)) {
    const issue = globalsInPlaceSaveIssue(cell.text);
    if (issue) throw new HttpError(422, issue);
  }
}
