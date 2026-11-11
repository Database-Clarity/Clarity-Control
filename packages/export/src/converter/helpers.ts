// Local replacements for the few lodash and @icemourne/tool-box functions the held converter used.
// Each one reproduces the exact behaviour the converter relied on (key order, in-place array edits,
// rounding), because the legacy files must stay byte-identical. See PROVENANCE.md.

/** Keys lodash's baseSet refuses to write; kept so `pick` never touches an object's prototype. */
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * lodash `pick` with plain keys: the result has the listed keys that exist on the object (own or
 * inherited, `key in object`), in the order of `keys`. A missing object gives `{}`.
 */
export const pick = <T extends object>(object: T | null | undefined, keys: readonly string[]): Partial<T> => {
  const result: Record<string, unknown> = {}
  if (object == null) return result as Partial<T>
  const source = Object(object) as Record<string, unknown>
  for (const key of keys) {
    if (unsafeKeys.has(key) || !(key in source)) continue
    result[key] = source[key]
  }
  return result as Partial<T>
}

/** Removes, in place, every element `drop` accepts (holes read as undefined); returns the same array. */
const pullInPlace = (array: unknown[], drop: (value: unknown) => boolean): unknown[] => {
  let write = 0
  for (let read = 0; read < array.length; read++) {
    const value = array[read]
    if (!drop(value)) array[write++] = value
  }
  array.length = write
  return array
}

const isNullish = (value: unknown) => value === undefined || value === null
const isNullishOrNaN = (value: unknown) => isNullish(value) || Number.isNaN(value)

/** lodash `isEmpty` for the values cleanObject meets (arrays, maps, sets, plain objects). */
const isEmptyObject = (value: object): boolean => {
  if (Array.isArray(value)) return value.length === 0
  if (value instanceof Map || value instanceof Set) return value.size === 0
  for (const key in value) if (Object.prototype.hasOwnProperty.call(value, key)) return false
  return true
}

/**
 * tool-box `cleanObject`: removes null, undefined, NaN, and (after cleaning) empty arrays, objects,
 * maps, and sets, at every depth. Works on a structured clone unless `allowMutations` is set.
 */
export function cleanObject<T>(dirtyObject: T, allowMutations = false): T {
  const obj = allowMutations ? dirtyObject : structuredClone(dirtyObject)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remover = (obj: any): any => {
    for (const key in obj) {
      // Remove null, undefined, NaN from array
      if (Array.isArray(obj[key])) {
        obj[key] = pullInPlace(obj[key], isNullishOrNaN)
      }
      // remove null undefined
      if (isNullish(obj[key])) delete obj[key]
      // Remove NaN values
      if (Number.isNaN(obj[key])) delete obj[key]
      // If values is not object continue
      if (!obj[key] || typeof obj[key] !== 'object') continue
      remover(obj[key])
      // Remove empty objects, arrays, maps and sets
      if (isEmptyObject(obj[key])) delete obj[key]
    }
    // Deleting properties from array makes them undefined this will remove undefined values from array
    if (Array.isArray(obj)) return pullInPlace(obj, (value) => value === undefined)
    return obj
  }
  return remover(obj)
}

/**
 * tool-box `customJsonStringify`, unchanged: `JSON.stringify` with `spaces` indentation, except that
 * the arrays under the named properties are printed on one line, e.g. `"classNames": [ "bold" ]`.
 */
export function customJsonStringify(object: unknown, properties: string[], spaces = 1): string {
  const string = JSON.stringify(object, undefined, spaces)
  const regex = new RegExp(`"(${properties.join('|')})"\\s*:\\s*\\[([^]+?)\\]`, 'g')
  const matches = string.match(regex)
  if (matches === null) return string
  const newString = matches.reduce((acc, match) => {
    acc = acc.replace(match, match.replaceAll('\n', '').replace(/  +/g, ' '))
    return acc
  }, string)
  return newString
}
