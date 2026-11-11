/**
 * Screenshots are re-encoded on a canvas before upload: longest side at most 1,600 px, WebP (or
 * JPEG where the browser cannot write WebP) at quality 0.8, which also drops EXIF. The target is
 * 400 KB; anything still over the server's 512 KB cap after a second, smaller pass is refused.
 */
export const maxScreenshots = 3;
const longest = 1600;
const target = 400 * 1024;
export const hardCap = 512 * 1024;

export interface Screenshot {
  id: string;
  blob: Blob;
  url: string;
  name: string;
}

export class ScreenshotError extends Error {}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareScreenshot(file: File): Promise<Screenshot> {
  if (!file.type.startsWith('image/')) throw new ScreenshotError('Only images can be attached.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScreenshotError(`${file.name} could not be read as an image.`);
  }
  let blob: Blob | null = null;
  for (const side of [longest, 1200]) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await encode(canvas, 'image/webp', 0.8);
    if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', 0.8);
    if (blob && blob.size <= target) break;
  }
  bitmap.close();
  if (!blob || blob.size > hardCap)
    throw new ScreenshotError('Too large; crop it or link a video.');
  return { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), name: file.name };
}
