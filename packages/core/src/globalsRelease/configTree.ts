import { z } from 'zod';
import { marksPath } from '../marks.js';

export const globalsConfigWithoutMarks = 'globalsConfigWithoutMarksV1';

const treeModes = new Set([0o40000, 0o100644, 0o100755, 0o120000, 0o160000]);
const treeEntry = z
  .object({
    nameRaw: z.string(),
    mode: z
      .number()
      .int()
      .transform((mode) =>
        treeModes.has(mode) || !/^[0-7]+$/.test(String(mode)) ? mode : parseInt(String(mode), 8),
      )
      .refine((mode) => treeModes.has(mode)),
    oid: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
const entriesSchema = z.array(treeEntry);
type TreeEntry = z.infer<typeof treeEntry>;
const encoder = new TextEncoder();
const marksName = marksPath.slice('config/'.length);

const join = (parts: readonly Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

async function gitTreeOid(entries: readonly TreeEntry[]) {
  const seen = new Set<string>();
  const sorted = entries.map(({ nameRaw, mode, oid }) => {
    const name = atob(nameRaw);
    if (!name || name.includes('/') || name.includes('\0') || seen.has(name))
      throw new Error('Invalid Git tree filename');
    seen.add(name);
    return {
      sortKey: name + (mode === 0o40000 ? '/' : '\0'),
      bytes: join([
        encoder.encode(`${mode.toString(8)} `),
        Uint8Array.from(name, (byte) => byte.charCodeAt(0)),
        new Uint8Array(1),
        Uint8Array.from(oid.match(/../g)!, (byte) => parseInt(byte, 16)),
      ]),
    };
  });
  sorted.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const body = join(sorted.map(({ bytes }) => bytes));
  const object = join([encoder.encode(`tree ${body.length}\0`), body]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Git tree identity with the editor-only marks file excluded. The Worker independently
 * verifies the complete entry listing against the observed raw tree OID before filtering. */
export async function globalConfigIdentity(
  input: unknown,
  expectedRawOid?: string,
): Promise<string> {
  const entries = entriesSchema.parse(input);
  if (expectedRawOid !== undefined && (await gitTreeOid(entries)) !== expectedRawOid)
    throw new Error('Git config tree OID mismatch');
  return gitTreeOid(
    entries.filter(
      ({ nameRaw, mode }) =>
        !(atob(nameRaw) === marksName && (mode === 0o100644 || mode === 0o100755)),
    ),
  );
}
