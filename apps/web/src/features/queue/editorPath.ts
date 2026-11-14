import type { Lang } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { canonicalHash } from '../navigation/catalog';

/**
 * Where a tooltip opens in the editor: its canonical page, with `variant=` naming an enhanced
 * override or alias (the editor redirects a bare override hash to its base and loses the variant).
 */
export function editorPath(hash: number, data: EditorData, lang?: Lang): string {
  const canonical = canonicalHash(hash, data);
  const query = [
    ...(lang ? [`lang=${lang}`] : []),
    ...(canonical === hash ? [] : [`variant=${hash}`]),
  ];
  return `/t/${canonical}${query.length ? `?${query.join('&')}` : ''}`;
}
