import { describe, expect, it } from 'vitest';
import { displayText, displayRevision, resolveReportAnchor } from './displayText.js';
import { reportAnchorSchema, reportSubmissionSchema, reportVideoSchema } from './schemas.js';
describe('report selectors', () => {
  it('uses the real markup renderer, excludes popovers, and preserves UTF-16', async () => {
    const display = displayText('<solar/>🡅 <bold Café />');
    expect(display).toBe('🡅 Café');
    const rev = await displayRevision(display);
    const anchor = { rev, exact: '🡅', prefix: '', suffix: ' Café', start: 0, end: 2, line: 0 };
    expect(reportAnchorSchema.parse(anchor)).toEqual(anchor);
    expect(resolveReportAnchor(display, rev, anchor)).toEqual({
      status: 'exact',
      start: 0,
      end: 2,
    });
    expect(resolveReportAnchor('new ' + display, 'b'.repeat(16), anchor)).toEqual({
      status: 'moved',
      start: 4,
      end: 6,
    });
    expect(resolveReportAnchor('changed', rev, anchor)).toEqual({ status: 'stale' });
    expect(
      resolveReportAnchor('🡅 🡅', 'b'.repeat(16), { ...anchor, prefix: '', suffix: '' }),
    ).toEqual({ status: 'stale' });
  });
  it('bounds offsets, lengths, controls, and evidence hosts', () => {
    expect(
      reportAnchorSchema.safeParse({
        rev: 'a'.repeat(16),
        exact: 'x',
        prefix: '',
        suffix: '',
        start: 4096,
        end: 4097,
        line: 0,
      }).success,
    ).toBe(false);
    expect(reportVideoSchema.safeParse('https://youtube.com.evil.example/video').success).toBe(
      false,
    );
    expect(reportVideoSchema.safeParse('https://cdn.discordapp.com/file').success).toBe(false);
    expect(reportVideoSchema.safeParse('https://youtu.be/abc').success).toBe(true);
    expect(reportSubmissionSchema.safeParse({}).success).toBe(false);
  });
});
