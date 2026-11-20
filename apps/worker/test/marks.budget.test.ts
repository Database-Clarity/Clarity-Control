import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { marksPath, maxMarksBytes, type Marks } from '@clarity/core/marks';
import { marksRoute } from '../src/marks.js';
import { GitHub, blobContent } from '../src/github.js';
import { config } from './fixture.js';

afterEach(() => vi.restoreAllMocks());
it('records a local CPU proxy for empty, typical, and byte-cap mark documents', async () => {
  // Fixed-seed fixtures: `note(index)` gives each mark's note length. The caps allow 700,000
  // bytes, so 1,050 marks with every tenth note at 2,000 characters is the 640 KB audit size,
  // 1,152 such marks is the byte cap, and 327 full-length notes fill the file too.
  const cases: { name: string; count: number; note: (index: number) => number; everyType?: boolean }[] = [
    { name: 'empty', count: 0, note: () => 30 },
    { name: 'typical', count: 100, note: () => 30 },
    { name: '256k', count: 390, note: () => 500 },
    { name: 'real-640k', count: 1050, note: (index) => (index % 10 === 0 ? 2000 : 304) },
    { name: 'cap-700k', count: 1152, note: (index) => (index % 10 === 0 ? 2000 : 300) },
    { name: 'cap-max-notes', count: 327, note: () => 2000 },
    { name: 'types', count: 32, note: () => 30, everyType: true },
  ];
  const rows = [];
  for (const { name, count: entries, note, everyType } of cases) {
    const notes = Array.from({ length: entries }, (_, index) => note(index));
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
        notes.map((length, index) => [
          index,
          [
            {
              type: 'retest',
              by: 1,
              at: '2026-11-15T00:00:00Z',
              note: 'x'.repeat(length),
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
        maxNote: notes.length ? Math.max(...notes) : 0,
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
