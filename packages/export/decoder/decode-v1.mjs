// Reference decoder for format v1 files from data.d2clarity.com (MIT). Copy it into your app as is.
//
// A v1 file stores each distinct description once, in `texts`, and every item points at its text
// by index `t`:  { "texts": [ { "en": ... } ], "items": { "<hash>": { "name": "...", "t": 0 } } }.
// decodeV1 returns the per-hash shape older files used:
//   { "<hash>": { "hash": <number>, "name": "...", "descriptions": { "en": ... } } }
// Items that share a text share the same object; copy it (structuredClone) before changing it.

/**
 * @param {{ texts: object[], items: Record<string, { t: number }> }} file A parsed v1 file.
 * @returns {Record<string, { hash: number, descriptions: object }>}
 */
export function decodeV1(file) {
  /** @type {Record<string, { hash: number, descriptions: object }>} */
  const decoded = {};
  for (const [hash, item] of Object.entries(file.items)) {
    const { t, ...keys } = item;
    const descriptions = file.texts[t];
    if (descriptions === undefined) throw new Error(`Item ${hash} points at missing text ${t}`);
    decoded[hash] = { hash: Number(hash), ...keys, descriptions };
  }
  return decoded;
}
