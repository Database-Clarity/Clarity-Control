// Types of the reference decoder (decode-v1.mjs), for packages that type-check without allowJs.
export function decodeV1(file: {
  texts: object[];
  items: Record<string, { t: number }>;
}): Record<string, { hash: number; descriptions: object }>;
