import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { marksPath, maxMarksBytes, type Marks } from '@clarity/core/marks';
import { marksRoute } from '../src/marks.js';
import { GitHub, blobContent } from '../src/github.js';
import { config } from './fixture.js';

afterEach(() => vi.restoreAllMocks());
it('records a local CPU proxy for empty, typical, and byte-cap mark documents', async () => {
  // The caps allow 768,000 bytes: 1,500 marks carry about 375-character notes, 1,100 marks
  // about 350 (520 KB), and 359 full-length 2,000-character notes fill the file.
  const cases = [
    { name: 'empty', entries: 0, note: 30 },
    { name: 'typical', entries: 100, note: 30 },
    { name: '256k', entries: 390, note: 500 },
    { name: 'cap-1500', entries: 1500, note: 375 },
    { name: '520k', entries: 1100, note: 348 },
    { name: 'cap-max-notes', entries: 359, note: 2000 },
    { name: 'types', entries: 32, note: 30, everyType: true },
  ];
  const rows = [];
  for (const { name, entries, note, everyType } of cases) {
    const marks: Marks = {
      types: [
        {
          id: 'retest',
          label: 'Needs retesting',
          colour: 'amber',
          by: 1,
          at: '2026-11-15T00:00:00Z',
        },
      ],
      entries: Object.fromEntries(
        Array.from({ length: entries }, (_, index) => [
          index,
          [
            {
              type: 'retest',
              by: 1,
              at: '2026-11-15T00:00:00Z',
              note: 'x'.repeat(note),
            },
          ],
        ]),
      ),
    };
    if (everyType) {
      marks.types = Array.from({ length: 31 }, (_, index) => ({
        ...marks.types[0],
        id: `type-${index}`,
        label: `Type ${index}`,
      }));
      marks.entries = Object.fromEntries(
        Array.from({ length: 32 }, (_, hash) => [
          hash,
          marks.types.map((type) => ({ type: type.id, by: 1, at: '2026-11-15T00:00:00Z' })),
        ]),
      );
    }
    const stored = blobContent(marks);
    expect(Buffer.byteLength(stored)).toBeLessThan(maxMarksBytes);
    const github = new GitHub({ DATA_BRANCH: 'editor-data' } as never);
    vi.spyOn(github, 'head').mockResolvedValue('a'.repeat(40));
    vi.spyOn(github, 'files').mockImplementation(async () => [
      { sha: 'b'.repeat(40), value: config },
      { sha: 'c'.repeat(40), value: JSON.parse(stored) },
    ]);
    vi.spyOn(github, 'commit').mockResolvedValue('d'.repeat(40));
    for (const method of ['GET', 'PUT']) {
      const run = async () => {
        const response = await marksRoute(
          new Request('https://api.test/marks', {
            method,
            ...(method === 'PUT'
              ? {
                  body: JSON.stringify({
                    revision: 'c'.repeat(40),
                    change: {
                      action: 'mark',
                      hash: 0,
                      type: everyType ? 'type-0' : 'retest',
                      note: 'Updated',
                    },
                  }),
                }
              : {}),
          }),
          github,
          { id: 1, login: 'alice' },
        );
        expect(response.status).toBe(200);
        await response.text();
      };
      for (let index = 0; index < 5; index++) await run();
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let index = 0; index < 100; index++) await run();
      const elapsed = process.cpuUsage(cpu);
      rows.push({
        name,
        entries,
        note,
        bytes: Buffer.byteLength(stored),
        method,
        cpuProxyMs: (elapsed.user + elapsed.system) / 100000,
        wallMs: (performance.now() - start) / 100,
      });
    }
  }
  console.log('MARKS_CPU_PROXY', JSON.stringify(rows));
  if (process.env.MARKS_CPU_OUTPUT)
    writeFileSync(process.env.MARKS_CPU_OUTPUT, JSON.stringify({ path: marksPath, rows }, null, 2));
});
