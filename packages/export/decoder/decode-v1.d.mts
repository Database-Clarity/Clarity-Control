// Types of the reference decoder (decode-v1.mjs), for packages that type-check without allowJs.
// Each perk keeps the keys the file chose (name, itemHash, itemName, category, edited, references).
export function decodeV1(file: {
  descriptions: object[];
  perks: Record<string, { description: number }>;
}): Record<string, { hash: number; descriptions: object; [key: string]: unknown }>;
