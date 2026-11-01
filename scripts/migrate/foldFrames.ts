import {
  aliasesSchema,
  languages,
  resolveAlias,
  tooltipSchema,
  type Aliases,
  type Lang,
  type LangText,
  type Pushed,
  type Tooltip,
} from '@clarity/core';

export interface ReplacedText {
  name: string;
  canonical: number;
  hash: number;
  language: Lang;
  value: LangText;
}

export function foldFrames(
  input: readonly Tooltip[],
  inputAliases: Aliases,
  pushed: Pushed,
  names: Record<string, { name: string }>,
) {
  const aliases = aliasesSchema.parse(inputAliases);
  const tooltips = new Map<number, Tooltip>();
  for (const inputTooltip of input) {
    const tooltip = tooltipSchema.parse(inputTooltip);
    if (tooltips.has(tooltip.hash)) throw new Error(`Duplicate tooltip ${tooltip.hash}`);
    tooltips.set(tooltip.hash, structuredClone(tooltip));
  }
  const groups = new Map<number, number[]>();
  for (const [hash, alias] of Object.entries(aliases)) {
    if (alias.kind !== 'frame') continue;
    const canonical = resolveAlias(Number(hash), aliases);
    const members = groups.get(canonical) ?? [canonical];
    members.push(Number(hash));
    groups.set(canonical, members);
  }
  const conflicts: ReplacedText[] = [];
  const folded: number[] = [];
  const nextPushed = { ...pushed };
  for (const [canonical, hashes] of groups) {
    const members = hashes
      .sort((a, b) => a - b)
      .map((hash) => tooltips.get(hash))
      .filter((value): value is Tooltip => value !== undefined);
    if (!members.length) continue;
    const original = tooltips.get(canonical);
    const next: Tooltip = original
      ? structuredClone(original)
      : { hash: canonical, text: {}, associated: [] };
    for (const language of languages) {
      const versions = members.flatMap((member) => {
        const value = member.text[language];
        return value ? [{ hash: member.hash, value }] : [];
      });
      if (!versions.length) continue;
      const sameText = new Set(versions.map((version) => version.value.text)).size === 1;
      versions.sort(
        (a, b) =>
          Number(b.value.text.trim() !== '') - Number(a.value.text.trim() !== '') ||
          Date.parse(b.value.updatedAt) - Date.parse(a.value.updatedAt) ||
          Number(b.hash === canonical) - Number(a.hash === canonical) ||
          a.hash - b.hash,
      );
      const winner =
        sameText && original?.text[language]
          ? { hash: canonical, value: original.text[language] }
          : versions[0];
      next.text[language] = winner.value;
      for (const version of versions) {
        if (version.value.text !== winner.value.text) {
          conflicts.push({
            name: names[canonical]?.name ?? String(canonical),
            canonical,
            hash: version.hash,
            language,
            value: version.value,
          });
        }
      }
    }
    next.associated = [...new Set(members.flatMap((member) => member.associated))];
    tooltips.set(canonical, next);
    // Every group needs publishing once so existing live member entries are refreshed.
    delete nextPushed[canonical];
    for (const hash of hashes) {
      if (hash === canonical) continue;
      if (tooltips.delete(hash)) folded.push(hash);
      delete nextPushed[hash];
    }
  }
  for (const tooltip of tooltips.values()) {
    tooltip.associated = [
      ...new Set(tooltip.associated.map((hash) => resolveAlias(hash, aliases))),
    ];
    tooltipSchema.parse(tooltip);
  }
  return {
    tooltips: [...tooltips.values()].sort((a, b) => a.hash - b.hash),
    pushed: nextPushed,
    conflicts,
    folded: folded.sort((a, b) => a - b),
  };
}

export function conflictNotes(conflicts: readonly ReplacedText[]): string {
  const sections = conflicts.map(
    ({ name, canonical, hash, language, value }) =>
      `## ${name} — canonical ${canonical}; replaced ${hash} (${language})\n\n` +
      `Author: ${value.updatedBy || '(unknown)'}\n\nDate: ${value.updatedAt}\n\n` +
      `Full text (JSON string, lossless):\n\n${JSON.stringify(value.text)}\n`,
  );
  return (
    `# Frame grouping replaced texts\n\n${conflicts.length} replaced language versions. ` +
    `Original complete tooltip files remain in editor-data git history.\n\n${sections.join('\n')}`
  );
}
