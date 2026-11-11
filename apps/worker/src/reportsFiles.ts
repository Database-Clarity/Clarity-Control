import { HttpError } from './http.js';

const bad = (format: string): never => {
  throw new HttpError(400, `Malformed ${format}`);
};
const ascii = (data: Uint8Array, at: number, size: number) =>
  String.fromCharCode(...data.subarray(at, at + size));

/** Structural image validation and metadata removal; never trust Content-Type. */
export function reportImage(input: Uint8Array): { mime: string; bytes: Uint8Array<ArrayBuffer> } {
  if (input[0] === 0xff && input[1] === 0xd8) return jpeg(input);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => input[i] === v)) return png(input);
  if (ascii(input, 0, 4) === 'RIFF' && ascii(input, 8, 4) === 'WEBP') return webp(input);
  throw new HttpError(415, 'Use a JPEG, PNG, or WebP screenshot');
}

function jpeg(input: Uint8Array) {
  const chunks = [input.subarray(0, 2)];
  let at = 2,
    frame = false,
    scan = false;
  while (at < input.length) {
    const start = at;
    if (input[at++] !== 0xff) bad('JPEG');
    while (input[at] === 0xff) at++;
    const marker = input[at++];
    if (marker === 0xd9) {
      if (!frame || !scan) bad('JPEG');
      chunks.push(new Uint8Array([0xff, 0xd9]));
      // Bytes after EOI are never part of the image and may carry metadata.
      return { mime: 'image/jpeg', bytes: concat(chunks) };
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      at + 2 > input.length
    )
      bad('JPEG');
    const length = (input[at] << 8) | input[at + 1],
      end = at + length;
    if (length < 2 || end > input.length) bad('JPEG');
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      const components = input[at + 7];
      if (
        length < 11 ||
        components < 1 ||
        components > 4 ||
        length !== 8 + 3 * components ||
        !(input[at + 3] || input[at + 4]) ||
        !(input[at + 5] || input[at + 6])
      )
        bad('JPEG');
      frame = true;
    }
    // Drop all application segments and comments, including between scans.
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe)
      chunks.push(input.subarray(start, end));
    at = end;
    if (marker === 0xda) {
      const components = input[end - length + 2];
      if (!frame || components < 1 || components > 4 || length !== 6 + 2 * components) bad('JPEG');
      scan = true;
      const entropy = at;
      while (at < input.length) {
        const next = input.indexOf(0xff, at);
        if (next < 0) bad('JPEG');
        let code = next + 1;
        while (input[code] === 0xff) code++;
        const value = input[code];
        if (value === 0 || (value >= 0xd0 && value <= 0xd7)) {
          at = code + 1;
          continue;
        }
        chunks.push(input.subarray(entropy, next));
        at = next;
        break;
      }
      if (at >= input.length) bad('JPEG');
    }
  }
  return bad('JPEG');
}

function png(input: Uint8Array) {
  const chunks = [input.subarray(0, 8)],
    view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let at = 8,
    header = false,
    pixels = false;
  const safe = new Set([
    'IHDR',
    'PLTE',
    'IDAT',
    'IEND',
    'cHRM',
    'gAMA',
    'sBIT',
    'sRGB',
    'bKGD',
    'pHYs',
    'tRNS',
  ]);
  while (at + 12 <= input.length) {
    const length = view.getUint32(at),
      type = ascii(input, at + 4, 4),
      end = at + 12 + length;
    if (end > input.length || !/^[A-Za-z]{4}$/.test(type)) bad('PNG');
    if (!header) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        !view.getUint32(at + 8) ||
        !view.getUint32(at + 12) ||
        ![0, 2, 3, 4, 6].includes(input[at + 17]) ||
        input[at + 18] !== 0 ||
        input[at + 19] !== 0 ||
        input[at + 20] > 1
      )
        bad('PNG');
      const depth = input[at + 16],
        color = input[at + 17];
      if (!(color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16]).includes(depth))
        bad('PNG');
      header = true;
    } else if (type === 'IHDR') bad('PNG');
    if (type === 'IDAT') {
      if (!length) bad('PNG');
      pixels = true;
    }
    if (!safe.has(type) && (input[at + 4] & 32) === 0) bad('PNG');
    // Unknown ancillary chunks can hold arbitrary identifying metadata.
    if (safe.has(type)) chunks.push(input.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      if (!pixels || length !== 0 || at !== input.length) bad('PNG');
      return { mime: 'image/png', bytes: concat(chunks) };
    }
  }
  return bad('PNG');
}

function webp(input: Uint8Array) {
  if (input.length < 20) bad('WebP');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(4, true) + 8 !== input.length) bad('WebP');
  const chunks = [input.slice(0, 12)];
  let at = 12,
    first = true,
    pixels = false;
  while (at + 8 <= input.length) {
    const type = ascii(input, at, 4),
      length = view.getUint32(at + 4, true),
      end = at + 8 + length + (length & 1);
    if (end > input.length || (first && !['VP8 ', 'VP8L', 'VP8X'].includes(type))) bad('WebP');
    if (type === 'VP8X') {
      if (!first || length !== 10 || (input[at + 8] & 0xc3) !== 0) bad('WebP');
      const chunk = input.slice(at, end);
      chunk[8] &= ~0x2c;
      chunks.push(chunk);
    } else if (type === 'VP8 ') {
      if (
        pixels ||
        length < 10 ||
        (input[at + 8] & 1) !== 0 ||
        ascii(input, at + 11, 3) !== '\x9d\x01\x2a' ||
        !(view.getUint16(at + 14, true) & 0x3fff) ||
        !(view.getUint16(at + 16, true) & 0x3fff)
      )
        bad('WebP');
      pixels = true;
      chunks.push(input.subarray(at, end));
    } else if (type === 'VP8L') {
      if (pixels || length < 5 || input[at + 8] !== 0x2f || (input[at + 12] & 0xe0) !== 0)
        bad('WebP');
      pixels = true;
      chunks.push(input.subarray(at, end));
    } else if (type === 'ALPH') {
      if (first || pixels || !length) bad('WebP');
      chunks.push(input.subarray(at, end));
    } else if (['ANIM', 'ANMF'].includes(type)) bad('WebP');
    // EXIF, XMP, ICC, and unknown chunks are omitted.
    first = false;
    at = end;
  }
  if (at !== input.length || !pixels) bad('WebP');
  const bytes = concat(chunks);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return { mime: 'image/webp', bytes };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export async function reportImageBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Screenshot required');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 524288) {
        await reader.cancel();
        throw new HttpError(413, 'Screenshot exceeds 512 KB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks);
}
