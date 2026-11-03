import { expect, it } from 'vitest';
import { z } from 'zod';
import { appJwt, signToken, verifyToken } from '../src/crypto.js';
import { makePrivateKey } from './fixture.js';

it('cached session keys never authenticate tokens under another or invalid secret', async () => {
  const a = 'a'.repeat(32);
  const b = 'b'.repeat(32);
  const schema = z.object({ id: z.number() });
  const token = await signToken({ id: 1 }, a);
  await expect(verifyToken(token, a, schema)).resolves.toEqual({ id: 1 });
  await expect(verifyToken(token, b, schema)).rejects.toThrow();
  await expect(verifyToken(token, '', schema)).rejects.toThrow();
  await expect(verifyToken(token, a, schema)).resolves.toEqual({ id: 1 });
});

it('an invalid rotated App key cannot reuse a previously imported RSA key', async () => {
  const pem = await makePrivateKey();
  expect(await appJwt('1', pem)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  await expect(appJwt('1', 'invalid')).rejects.toThrow();
  expect(await appJwt('2', pem)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
});
