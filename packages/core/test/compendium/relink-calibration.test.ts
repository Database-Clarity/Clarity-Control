import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  resolveCompendiumLink,
  snapshotCompendium,
  compendiumSimilarity,
  COMPENDIUM_RELINK_THRESHOLD,
  COMPENDIUM_RELINK_MARGIN,
} from '../../src/compendium/resolve.js';
import { sameCell, type CompendiumData } from '../../src/compendium/types.js';
const old: CompendiumData = JSON.parse(
  readFileSync(new URL('./fixtures/reviewed-source.json', import.meta.url), 'utf8'),
);
const current: CompendiumData = JSON.parse(
  readFileSync(
    new URL(
      '../../../../apps/web/src/features/compendium/fixtures/frozen-matcher.json',
      import.meta.url,
    ),
    'utf8',
  ),
).source;
it('calibrates strict suggestions against frozen sheet history and rename-like pairs', () => {
  let historical = 0,
    renameLike = 0,
    correct = 0,
    wrong = 0,
    negatives = 0;
  const scores: { score: number; margin: number; correct: boolean }[] = [];
  const evaluate = (snapshot: string, expected: string | undefined, source: CompendiumData) => {
    const ranked = source.tabs
      .flatMap((tab) =>
        tab.rows.map((row) => ({ row, score: compendiumSimilarity(snapshot, row.cell.plain) })),
      )
      .sort((a, b) => b.score - a.score);
    if (ranked[0])
      scores.push({
        score: ranked[0].score,
        margin: ranked[0].score - (ranked[1]?.score ?? 0),
        correct: ranked[0].row.name === expected,
      });
    const link = {
      ...snapshotCompendium({ tab: old.tabs[0], row: old.tabs[0].rows[0] }),
      rowKey: '__old renamed identity__',
      snapshot: { plain: snapshot, runs: [{ text: snapshot }] },
    };
    const result = resolveCompendiumLink(link, source);
    if (result.status === 'relink-suggested') {
      if (result.candidate.row.name === expected) correct++;
      else wrong++;
    }
  };
  for (const tab of old.tabs)
    for (const row of tab.rows) {
      const next = current.tabs
        .find((t) => t.gid === tab.gid)
        ?.rows.filter((r) => r.name === row.name);
      if (next?.length === 1 && !sameCell(row.cell, next[0].cell)) {
        historical++;
        evaluate(row.cell.plain, row.name, current);
      }
    }
  // Simulated lost names, with a punctuation edit so exact-content recovery cannot mask suggestions.
  // All competitors remain, including near-duplicate rows. Negatives remove the true identity.
  for (const tab of current.tabs)
    for (const row of tab.rows) {
      if (!row.cell.plain.trim()) continue;
      for (const snapshot of new Set([
        row.cell.plain + '!',
        row.cell.plain.replace(/\s+\S+\s*$/, ''),
        row.cell.plain.replace(/\d/, '9'),
      ])) {
        if (snapshot === row.cell.plain || !snapshot.trim()) continue;
        renameLike++;
        evaluate(snapshot, row.name, current);
        negatives++;
        evaluate(snapshot, undefined, {
          ...current,
          tabs: current.tabs.map((t) => ({
            ...t,
            rows: t.rows.filter((r) => r.nameNorm !== row.nameNorm),
          })),
        });
      }
    }
  console.log(
    'threshold sweep',
    [0.85, 0.9, 0.95, 0.98].flatMap((threshold) =>
      [0.05, 0.1, 0.15].map((margin) => {
        const selected = scores.filter((s) => s.score >= threshold && s.margin >= margin);
        return {
          threshold,
          margin,
          accepted: selected.length,
          wrong: selected.filter((s) => !s.correct).length,
        };
      }),
    ),
  );
  const accepted = scores.filter(
    (s) => s.score >= COMPENDIUM_RELINK_THRESHOLD && s.margin >= COMPENDIUM_RELINK_MARGIN,
  );
  console.log(
    JSON.stringify({
      historical,
      renameLike,
      negatives,
      correct,
      wrong,
      precision: correct / (correct + wrong),
      rankedAccepted: accepted.length,
    }),
  );
  expect({ historical, renameLike, negatives, correct, wrong }).toEqual({
    historical: 0,
    renameLike: 155,
    negatives: 155,
    correct: 139,
    wrong: 0,
  });
  expect(wrong).toBe(0);
}, 120_000);
