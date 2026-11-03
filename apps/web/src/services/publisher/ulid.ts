const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID the Worker accepts as an opId: 48-bit millisecond time (checked server-side to be within
 * +-24 h when the request is created) followed by 80 random bits, Crockford base32.
 */
export function newOpId(
  now = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  let time = '';
  let rest = now;
  for (let index = 0; index < 10; index++) {
    time = alphabet[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = random(new Uint8Array(16));
  let tail = '';
  for (const byte of bytes) tail += alphabet[byte % 32];
  return time + tail;
}
