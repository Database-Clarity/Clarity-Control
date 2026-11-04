import { bundleSchema } from './bundleSchema';
import { itemsSchema } from './generatorSchema';

export type ValidationKind = 'bundle' | 'items';

/** Run the original schemas, including refinements/defaults and unknown-field stripping. */
export function validateJsonBytes(kind: ValidationKind, bytes: ArrayBuffer): ArrayBuffer {
  const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const output = (kind === 'bundle' ? bundleSchema : itemsSchema).parse(input);
  return new TextEncoder().encode(JSON.stringify(output)).buffer;
}
