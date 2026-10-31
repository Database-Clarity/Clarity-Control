import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  parseCompendiumGrid,
  parseCompendiumSheet,
  parseCompendiumTabs,
} from '../../src/compendium/parser.js';
import { compendiumDataSchema } from '../../src/compendium/types.js';

it.runIf(!!process.env.COMPENDIUM_FIXTURE_DIR)(
  'parses all downloaded real tabs without dropping a tab',
  () => {
    const directory = process.env.COMPENDIUM_FIXTURE_DIR!;
    const landing = readFileSync(`${directory}\\compendium-1027-landing.html`, 'utf8');
    const tabs = parseCompendiumTabs(landing).map(({ gid, name }) => {
      if (process.env.COMPENDIUM_GID && gid !== process.env.COMPENDIUM_GID)
        return { gid, name, rows: [] };
      const source = readFileSync(`${directory}\\compendium-1027-${gid}.html`, 'utf8');
      const sheet = parseCompendiumSheet(source, gid, name);
      if (!sheet.rows.length && name !== 'Landing')
        console.info(
          parseCompendiumGrid(source)
            .slice(0, 7)
            .map((row) => [row.row, row.cells.map((cell) => cell?.cell.plain.slice(0, 50))]),
        );
      if (name !== 'Landing') expect(sheet.rows.length, name).toBeGreaterThan(0);
      console.info(`${name}: ${sheet.rows.length} rows`);
      return sheet;
    });
    expect(
      compendiumDataSchema.safeParse({ fetchedAt: new Date().toISOString(), tabs }).success,
    ).toBe(true);
  },
);
