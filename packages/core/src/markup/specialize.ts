import { z } from 'zod';
import { markupWeaponTypes } from './syntax.js';
import type { MarkupCell, MarkupLine, MarkupSpan } from './types.js';

/**
 * Singular localized weapon-type labels: `{ "<canonical name>": { "<lang>": "<label>" } }`, the
 * shape of the generator's `templates/v2/weaponTypes.json`. `en` is always present; other
 * languages may be missing (consumers fall back to English).
 */
export const weaponTypeLabelsSchema = z.record(
  z.string(),
  z.record(z.string(), z.string()).refine((labels) => typeof labels.en === 'string', {
    message: 'Weapon type labels need an English entry',
  }),
);
export type WeaponTypeLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** English singular labels, equal to the canonical names ("Hand Cannon"). */
export const englishWeaponTypeLabels: WeaponTypeLabels = Object.fromEntries(
  markupWeaponTypes.map((name) => [name, { en: name }]),
);

/** Label for a canonical weapon type: the language, else English, else the name itself. */
export function weaponTypeLabel(
  table: WeaponTypeLabels | undefined,
  name: string,
  language: string,
): string {
  const labels = table?.[name];
  return labels?.[language] ?? labels?.en ?? name;
}

/**
 * The full table: English defaults for every markup weapon type merged under the given table.
 * Keys are ordered deterministically (defaults, then any other names sorted; `en`, then other
 * languages sorted), so the same table always serialises to the same bytes.
 */
export function completeWeaponTypeLabels(table?: WeaponTypeLabels): WeaponTypeLabels {
  const merged = new Map<string, Record<string, string>>();
  for (const name of markupWeaponTypes) merged.set(name, { en: name });
  for (const [name, labels] of Object.entries(table ?? {})) {
    merged.set(name, { ...merged.get(name), ...labels });
  }
  const extra = [...merged.keys()].filter((name) => !markupWeaponTypes.includes(name)).sort();
  return Object.fromEntries(
    [...markupWeaponTypes, ...extra].map((name) => {
      const labels = merged.get(name)!;
      const others = Object.keys(labels)
        .filter((language) => language !== 'en')
        .sort();
      return [
        name,
        Object.fromEntries(['en', ...others].map((language) => [language, labels[language]])),
      ];
    }),
  );
}

export type WeaponTypeChoice =
  /** One weapon type: shared lines plus that type's sections, all untagged. */
  | { type: string }
  | {
      /** Label table (merged over the English defaults); `{}` means English defaults. */
      labelled: WeaponTypeLabels;
      /** Language of the labels; English when omitted. */
      language?: string;
      /**
       * Weapon types the tooltip actually applies to. A block's label then names only the
       * types it covers among these (so an `other` block lists the remaining ones).
       */
      among?: readonly string[];
    };

function strip(line: MarkupLine): MarkupLine {
  const rest = { ...line };
  delete rest.weaponTypes;
  delete rest.weaponBlock;
  delete rest.weaponOther;
  return rest;
}

type Apply = (lines: MarkupLine[]) => MarkupLine[];

function mapSpans(spans: MarkupSpan[] | undefined, apply: Apply) {
  return spans?.map((span) => (span.title ? { ...span, title: apply(span.title) } : span));
}

/** Applies `apply` to the lines of every title nested in the line's spans and table cells. */
function mapNested(line: MarkupLine, apply: Apply): MarkupLine {
  const result: MarkupLine = { ...line };
  if (line.linesContent) result.linesContent = mapSpans(line.linesContent, apply);
  if (line.table) {
    result.table = line.table.map((row) => ({
      ...row,
      ...(row.rowContent && {
        rowContent: row.rowContent.map((cell): MarkupCell => ({
          ...cell,
          cellContent: mapSpans(cell.cellContent, apply) ?? [],
        })),
      }),
    }));
  }
  return result;
}

function labelFor(
  line: MarkupLine,
  labels: WeaponTypeLabels,
  language: string,
  among: readonly string[] | undefined,
): string | undefined {
  const types = line.weaponTypes ?? [];
  const relevant = among ? types.filter((type) => among.includes(type)) : types;
  if (line.weaponOther && (!relevant.length || !among))
    return labels.other?.[language] ?? labels.other?.en ?? 'Other';
  const shown = relevant.length ? relevant : types;
  return shown.length
    ? shown.map((type) => weaponTypeLabel(labels, type, language)).join(', ')
    : undefined;
}

/**
 * Turns parsed lines with weapon-type sections into plain lines.
 * `{ type }` keeps shared lines and that type's sections. `{ labelled }` keeps everything and
 * prefixes each section's first line with its label (e.g. "Sword: ").
 */
export function specializeWeaponTypes(
  lines: readonly MarkupLine[],
  choice: WeaponTypeChoice,
): MarkupLine[] {
  if ('type' in choice) {
    const keep: Apply = (input) =>
      input
        .filter((line) => !line.weaponTypes || line.weaponTypes.includes(choice.type))
        .map((line) => mapNested(strip(line), keep));
    return keep([...lines]);
  }
  const labels = completeWeaponTypeLabels(choice.labelled);
  const language = choice.language ?? 'en';
  const label: Apply = (input) => {
    const output: MarkupLine[] = [];
    let previous: number | undefined;
    for (const line of input) {
      const mapped = mapNested(strip(line), label);
      const first = line.weaponBlock !== undefined && line.weaponBlock !== previous;
      previous = line.weaponBlock;
      const text = first ? labelFor(line, labels, language, choice.among) : undefined;
      if (text === undefined) output.push(mapped);
      else if (mapped.linesContent && !mapped.table) {
        output.push({ ...mapped, linesContent: [{ text: `${text}: ` }, ...mapped.linesContent] });
      } else output.push({ linesContent: [{ text: `${text}:` }] }, mapped);
    }
    return output;
  };
  return label([...lines]);
}
