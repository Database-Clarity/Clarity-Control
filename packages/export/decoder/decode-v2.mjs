// Reference decoder for format v2 files from data.d2clarity.com (MIT). Copy it into your app as is.
//
// A v2 file describes itself and stores each distinct description once, in `descriptions`; every
// perk points at its description by index:
//   { "format": 2, "shape": "lines", "languages": ["en"],
//     "descriptions": [ { "en": ... } ], "perks": { "<hash>": { "name": "...", "description": 0 } } }
// decodeV2 returns the per-hash shape older files used:
//   { "<hash>": { "hash": <number>, "name": "...", "descriptions": { "en": ... } } }
// Styles, including `exotic`, pass through unchanged in lines and nested notes.
// Perks that share a description share the same object; copy it (structuredClone) before changing it.

/**
 * @param {{ descriptions: object[], perks: Record<string, { description: number }> }} file A parsed v2 file.
 * @returns {Record<string, { hash: number, descriptions: object }>}
 */
export function decodeV2(file) {
  /** @type {Record<string, { hash: number, descriptions: object }>} */
  const decoded = {};
  for (const [hash, perk] of Object.entries(file.perks)) {
    const { description, ...keys } = perk;
    const descriptions = file.descriptions[description];
    if (descriptions === undefined)
      throw new Error(`Perk ${hash} points at missing description ${description}`);
    decoded[hash] = { hash: Number(hash), ...keys, descriptions };
  }
  return decoded;
}
