// Types of the reference decoder (decode-v1.mjs), for packages that type-check without allowJs.
export function decodeV1(file: {
  descriptions: object[];
  perks: Record<string, { description: number }>;
}): Record<string, { hash: number; descriptions: object }>;
