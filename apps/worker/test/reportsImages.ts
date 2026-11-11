/** Structurally valid tiny image envelopes, padded for bounded-storage probes. */
export function reportJpegFixture(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0,
  ]);
  bytes.set([255, 217], size - 2);
  return bytes;
}
export function reportPngFixture(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer),
    ascii = (at: number, text: string) => bytes.set(new TextEncoder().encode(text), at);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  ascii(12, 'IHDR');
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  bytes[24] = 8;
  bytes[25] = 6;
  view.setUint32(33, size - 57);
  ascii(37, 'IDAT');
  ascii(size - 8, 'IEND');
  return bytes;
}
export function reportWebpFixture(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'));
  view.setUint32(4, size - 8, true);
  bytes.set(new TextEncoder().encode('WEBPVP8 '), 8);
  view.setUint32(16, size - 20, true);
  bytes.set([0, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0], 20);
  return bytes;
}
