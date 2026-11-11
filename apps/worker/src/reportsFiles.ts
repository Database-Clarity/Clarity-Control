import { HttpError } from './http.js';

/** Strip identifying metadata before storage, including for clients bypassing the canvas. */
export function reportImage(input: Uint8Array): { mime: string; bytes: Uint8Array } {
  const ascii = (at: number, n: number) => String.fromCharCode(...input.subarray(at, at + n));
  const chunks: Uint8Array[] = [];
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    chunks.push(input.subarray(0, 2));
    let at = 2;
    while (at < input.length) {
      if (input[at] !== 0xff) throw new HttpError(400, 'Malformed JPEG');
      const marker = input[at + 1];
      if (marker === 0xda || marker === 0xd9) {
        chunks.push(input.subarray(at));
        return { mime: 'image/jpeg', bytes: concat(chunks) };
      }
      if (at + 4 > input.length) break;
      const size = (input[at + 2] << 8) | input[at + 3];
      if (size < 2 || at + 2 + size > input.length) break;
      if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe)
        chunks.push(input.subarray(at, at + 2 + size));
      at += 2 + size;
    }
    throw new HttpError(400, 'Malformed JPEG');
  }
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => input[i] === v)) {
    chunks.push(input.subarray(0, 8));
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    for (let at = 8; at + 12 <= input.length;) {
      const size = view.getUint32(at),
        type = ascii(at + 4, 4);
      if (size > input.length - at - 12) break;
      if (!['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type))
        chunks.push(input.subarray(at, at + size + 12));
      at += size + 12;
      if (type === 'IEND' && at === input.length)
        return { mime: 'image/png', bytes: concat(chunks) };
    }
    throw new HttpError(400, 'Malformed PNG');
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (view.getUint32(4, true) + 8 !== input.length) throw new HttpError(400, 'Malformed WebP');
    chunks.push(input.slice(0, 12));
    let at = 12;
    while (at + 8 <= input.length) {
      const size = view.getUint32(at + 4, true),
        type = ascii(at, 4),
        end = at + 8 + size + (size & 1);
      if (end > input.length) throw new HttpError(400, 'Malformed WebP');
      if (!['EXIF', 'XMP '].includes(type)) {
        const chunk = input.slice(at, end);
        if (type === 'VP8X' && size >= 10) chunk[8] &= ~12;
        chunks.push(chunk);
      }
      at = end;
    }
    if (at !== input.length) throw new HttpError(400, 'Malformed WebP');
    const bytes = concat(chunks);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    return { mime: 'image/webp', bytes };
  }
  throw new HttpError(415, 'Use a JPEG, PNG, or WebP screenshot');
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
