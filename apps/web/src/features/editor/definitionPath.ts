import { globalAggregateKind } from '@clarity/core';
import { globalAggregates, globalsEnabled } from '../../services/globalsFlag';
import { globalIdOf, useGlobalIdentities } from '../../stores/globalIdentities';
import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';
import { locateBlocks, locateVariables, type ReferenceTarget } from './references';

type TooltipTarget = Extract<ReferenceTarget, { type: 'tooltip' }>;

/**
 * The declaration that holds `line` of an aggregate's text (exports 1, variables 2, titles 3):
 * the last one starting at or before it. References and Find both point there by line.
 */
export function aggregateDeclaration(text: string, hash: number, line: number): string | undefined {
  const kind = globalAggregateKind(hash);
  const found =
    kind === 'variables'
      ? locateVariables(text)
      : locateBlocks(text, kind === 'titles' ? 'title' : 'export');
  let name: string | undefined;
  let start = 0;
  for (const located of found.values())
    if (located.line <= line && located.line >= start) {
      start = located.line;
      name = located.name;
    }
  return name;
}

/**
 * Where a go-to-definition (F12, Ctrl+click, the reference popover, Find) opens. With globals on,
 * a definition in an aggregate opens its own entry (`/globals/<id>`), never the aggregate: the
 * `/t/1`–`/t/3` hand-off has no line and would open the first entry of the kind.
 */
export function definitionPath(
  target: TooltipTarget,
  data: EditorData | null,
  globals = globalsEnabled,
): string {
  const lang = `?lang=${target.lang}`;
  if (globals && globalAggregates.includes(target.hash)) {
    const kind = globalAggregateKind(target.hash);
    const text = data?.bundle.tooltips[target.hash]?.text[target.lang]?.text ?? '';
    const name = aggregateDeclaration(text, target.hash, target.line);
    if (name === undefined) return `/globals${lang}`;
    const id = globalIdOf(useGlobalIdentities.getState().identities, kind, name);
    // Before the catalogue loads, the name route resolves the ID and replaces itself.
    return id ? `/globals/${id}${lang}` : `/globals/${kind}/${encodeURIComponent(name)}${lang}`;
  }
  const canonical = data ? canonicalHash(target.hash, data) : target.hash;
  return `/t/${canonical}${lang}&line=${target.line}&variant=${target.hash}`;
}
