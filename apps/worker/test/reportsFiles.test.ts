import { expect, it } from 'vitest';
import { reportImage } from '../src/reportsFiles.js';
import { reportJpegFixture, reportPngFixture, reportWebpFixture } from './reportsImages.js';
const join = (...chunks: Uint8Array[]) => Uint8Array.from(chunks.flatMap((p) => Array.from(p)));
const text = (value: string) => new TextEncoder().encode(value);
it('requires image structure beyond magic bytes', () => {
  expect(() =>
    reportImage(join(new Uint8Array([255, 216, 255, 218]), text('<html>not an image'))),
  ).toThrow('Malformed JPEG');
  const png = reportPngFixture();
  png.set(text('IDAT'), 12);
  expect(() => reportImage(png)).toThrow('Malformed PNG');
  const invalidDepth = reportPngFixture();
  invalidDepth[24] = 0;
  expect(() => reportImage(invalidDepth)).toThrow('Malformed PNG');
  const webp = reportWebpFixture();
  webp.set(text('JUNK'), 12);
  expect(() => reportImage(webp)).toThrow('Malformed WebP');
  for (const fixture of [reportJpegFixture(), reportPngFixture(), reportWebpFixture()])
    expect(reportImage(fixture).bytes).toEqual(fixture);
});
it('strips JPEG APP/COM between progressive scans and everything after EOI', () => {
  const base = reportJpegFixture(),
    marker = (kind: number, value: string) =>
      join(new Uint8Array([255, kind, 0, value.length + 2]), text(value));
  const image = join(
    base.subarray(0, 25),
    new Uint8Array([1, 255, 0, 2]),
    marker(0xe1, 'secret'),
    base.subarray(15, 25),
    new Uint8Array([3]),
    marker(0xed, 'hidden'),
    marker(0xfe, 'comment'),
    base.subarray(15, 25),
    new Uint8Array([4, 255, 217]),
    text('trailing-private'),
  );
  const stripped = reportImage(image).bytes,
    value = new TextDecoder().decode(stripped);
  for (const word of ['secret', 'hidden', 'comment', 'trailing-private'])
    expect(value).not.toContain(word);
  expect(stripped.slice(-2)).toEqual(new Uint8Array([255, 217]));
});
it('strips identifying PNG and WebP chunks', () => {
  const png = reportPngFixture(),
    value = text('private metadata'),
    chunk = new Uint8Array(value.length + 12);
  new DataView(chunk.buffer).setUint32(0, value.length);
  chunk.set(text('tEXt'), 4);
  chunk.set(value, 8);
  expect(reportImage(join(png.subarray(0, 33), chunk, png.subarray(33))).bytes).toEqual(png);
  const webp = reportWebpFixture(),
    exif = new Uint8Array(24);
  exif.set(text('EXIF'));
  new DataView(exif.buffer).setUint32(4, 16, true);
  exif.set(text('private metadata'), 8);
  const combined = join(webp, exif);
  new DataView(combined.buffer).setUint32(4, combined.length - 8, true);
  expect(reportImage(combined).bytes).toEqual(webp);
});
