import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { compendiumTabs } from '../../../packages/core/src/compendium/config.js';
import { compareSheet, discoverTabs, expectedCsvRows, isIncludedTab } from './compare.js';

const htmlDir = process.env.COMPENDIUM_COVERAGE_HTML_DIR;
test.skipIf(!htmlDir)('every live tab agrees with independently derived gviz CSV', async () => {
  const directory = resolve('scripts/compendium/coverage');
  const downloads = resolve(directory, 'downloads');
  await mkdir(downloads, { recursive: true });
  const discovered = discoverTabs(
    await readFile(resolve(htmlDir!, 'compendium-1027-landing.html'), 'utf8'),
  );
  const tabs = discovered.filter((tab) => isIncludedTab(tab.name));
  const excludedTabs = discovered
    .filter((tab) => !isIncludedTab(tab.name))
    .map((tab) => ({
      ...tab,
      reason: 'Intentionally excluded: case-sensitive uppercase OLD substring',
    }));
  let parser: typeof import('../../../packages/core/src/compendium/parser.js') | undefined;
  let parserError: string | undefined;
  try {
    parser = await import('../../../packages/core/src/compendium/parser.js');
  } catch (error) {
    parserError = String(error);
  }
  const reports = [];
  for (const tab of tabs) {
    const csvFile = resolve(downloads, `gviz-coverage-${tab.gid}.csv`);
    try {
      if (!existsSync(csvFile) || process.env.COMPENDIUM_COVERAGE_REFRESH) {
        const url = new URL(
          'https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/gviz/tq',
        );
        url.searchParams.set('tqx', 'out:csv');
        // gviz otherwise guesses headers and concatenates multiple physical rows.
        url.searchParams.set('headers', '0');
        url.searchParams.set('sheet', tab.name);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`gviz HTTP ${response.status}`);
        const csv = await response.text();
        if (/^\s*</.test(csv)) throw new Error('gviz returned HTML, not CSV');
        await writeFile(csvFile, csv);
      }
      const csv = await readFile(csvFile, 'utf8');
      const expected = expectedCsvRows(csv, compendiumTabs[tab.gid]);
      if (!parser) {
        reports.push({
          ...tab,
          csvNamedRows: expected.length,
          error: 'Core parser could not load; see parserError',
        });
        continue;
      }
      const html = await readFile(resolve(htmlDir!, `compendium-1027-${tab.gid}.html`), 'utf8');
      const parsed = parser.parseCompendiumSheet(html, tab.gid, tab.name);
      reports.push({ ...tab, ...compareSheet(expected, parsed.rows) });
    } catch (error) {
      reports.push({ ...tab, error: String(error) });
    }
  }
  const failures = reports.filter((report) => 'error' in report || report.mismatches.length);
  const missingTabs = Object.entries(compendiumTabs)
    .filter(([, config]) => isIncludedTab(config.name))
    .map(([gid]) => gid)
    .filter((gid) => !tabs.some((tab) => tab.gid === gid));
  const report = {
    generatedAt: new Date().toISOString(),
    status: parserError ? 'blocked' : failures.length || missingTabs.length ? 'failed' : 'passed',
    source: 'Independent gviz CSV; whitespace-only normalization',
    parserError,
    tabCount: tabs.length,
    excludedTabCount: excludedTabs.length,
    excludedTabs,
    missingConfiguredTabs: missingTabs,
    failedTabCount: failures.length,
    mismatchCount: parserError
      ? null
      : reports.reduce(
          (sum, entry) => sum + ('mismatches' in entry ? entry.mismatches.length : 0),
          0,
        ),
    csvNamedRows: reports.reduce(
      (sum, entry) => sum + ('csvNamedRows' in entry ? entry.csvNamedRows : 0),
      0,
    ),
    parsedNamedRows: parserError
      ? null
      : reports.reduce(
          (sum, entry) => sum + ('parsedNamedRows' in entry ? entry.parsedNamedRows : 0),
          0,
        ),
    tabs: reports,
  };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.table(
    reports.map((report) => ({
      tab: report.name,
      csv: 'csvNamedRows' in report ? report.csvNamedRows : '-',
      parsed: 'parsedNamedRows' in report ? report.parsedNamedRows : '-',
      mismatches: 'mismatches' in report ? report.mismatches.length : report.error,
    })),
  );
  expect(missingTabs, 'Landing must enumerate every configured tab').toEqual([]);
  expect(
    failures.map((entry) => entry.name),
    'See scripts/compendium/coverage/report.json for exact mismatches',
  ).toEqual([]);
});
