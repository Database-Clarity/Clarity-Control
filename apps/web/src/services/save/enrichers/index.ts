import type { Tooltip } from '@clarity/core';
import type { Me } from '../../api';
import type { Item } from '../../generator';
import { metadata } from './metadata';
import { bungie } from './bungie';
import { compendiumEnricher } from './compendium';

export type SaveEnricher = (ctx: {
  before: Tooltip | undefined;
  next: Tooltip;
  user: Me;
  item?: Item;
}) => Promise<Tooltip>;

export const saveEnrichers: SaveEnricher[] = [metadata, bungie, compendiumEnricher];
export default saveEnrichers;

export async function enrichTooltip(ctx: Parameters<SaveEnricher>[0]): Promise<Tooltip> {
  let next = ctx.next;
  for (const enrich of saveEnrichers) next = await enrich({ ...ctx, next });
  return next;
}
