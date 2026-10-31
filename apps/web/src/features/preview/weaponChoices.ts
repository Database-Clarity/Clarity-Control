import {
  specializeWeaponTypes,
  weaponTypeNames,
  type MarkupLine,
  type MarkupSpan,
  type WeaponTypeLabels,
} from '@clarity/core';

/** Select value for the labelled view; no weapon type name can collide with it. */
export const allLabelled = '*';

/** Every line, including those of titles nested in spans and table cells. */
function withNested(lines: readonly MarkupLine[]): MarkupLine[] {
  const titles = (spans: MarkupSpan[] | undefined) =>
    (spans ?? []).flatMap((span) => (span.title ? withNested(span.title) : []));
  return lines.flatMap((line) => [
    line,
    ...titles(line.linesContent),
    ...(line.table ?? []).flatMap((row) =>
      (row.rowContent ?? []).flatMap((cell) => titles(cell.cellContent)),
    ),
  ]);
}

/** True when the text, or a title it shows, has weapon-type sections: the picker is worth showing. */
export function hasWeaponSections(lines: readonly MarkupLine[]): boolean {
  return withNested(lines).some((line) => line.weaponTypes);
}

/**
 * Weapon types to preview: the item's `weaponTypes` facts when known, else every canonical
 * type; extra tags (Grenade, Melee, …) are added when a section names them explicitly.
 */
export function weaponChoices(
  lines: readonly MarkupLine[],
  facts: readonly string[] | undefined,
): string[] {
  if (facts?.length) return [...facts];
  const named = withNested(lines).flatMap((line) =>
    line.weaponOther ? [] : (line.weaponTypes ?? []),
  );
  return [
    ...weaponTypeNames,
    ...new Set(named.filter((name) => !weaponTypeNames.some((type) => type === name))),
  ];
}

/** Lines for the selected choice: one weapon type, or every section labelled. */
export function previewLines(
  lines: readonly MarkupLine[],
  choice: string,
  facts: readonly string[] | undefined,
  labels: WeaponTypeLabels = {},
  language = 'en',
): MarkupLine[] {
  if (!hasWeaponSections(lines)) return [...lines];
  return choice === allLabelled
    ? specializeWeaponTypes(lines, {
        labelled: labels,
        language,
        among: facts?.length ? facts : undefined,
      })
    : specializeWeaponTypes(lines, { type: choice });
}
