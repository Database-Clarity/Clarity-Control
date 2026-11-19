import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { plainError, requestError, serverError } from './httpError';

describe('request errors people can read', () => {
  it("keeps the server's sentence and drops the JSON around it", () => {
    const error = requestError('Permissions request', 404, '{"error":"Endpoint not found"}');
    expect(error.message).toBe('Permissions request: Endpoint not found');
    expect(error.cause).toBe('{"error":"Endpoint not found"}');
  });

  it('names only the status when the body is not a JSON error', () => {
    expect(requestError('Compendium refresh', 502, '<html>Bad gateway</html>').message).toBe(
      'Compendium refresh failed (the server answered 502).',
    );
    expect(serverError('{"error":""}')).toBeUndefined();
    expect(serverError('{"error":"Bad","details":["one",2,"two"]}')).toBe('Bad; one; two');
  });

  it('makes the older "<what> HTTP <status>: <body>" messages plain', () => {
    expect(plainError(new Error('Permissions HTTP 404: {"error":"not mocked"}'))).toBe(
      'Permissions: not mocked',
    );
    expect(plainError('API HTTP 404: {"error":"Tooltip did not exist at that commit"}')).toBe(
      'Tooltip did not exist at that commit',
    );
    expect(plainError('API HTTP 403: Forbidden')).toBe('Forbidden');
    expect(plainError('API HTTP 500: {"unexpected":true}')).toBe(
      'The request failed (the server answered 500).',
    );
    expect(plainError('Tooltip 123: HTTP 404')).toBe(
      'Tooltip 123 failed (the server answered 404).',
    );
    expect(plainError('Snippets could not load: Snippets are unavailable')).toBe(
      'Snippets could not load: Snippets are unavailable',
    );
  });

  it('drops an HTML page or JSON that a message carries, keeping its own words', () => {
    expect(plainError('<html><body>Bad gateway</body></html>')).toBe(
      'The server sent a reply this page cannot read. Retry, or reload the page.',
    );
    expect(plainError('Cannot load Compendium: <!DOCTYPE html><p>oops</p>')).toBe(
      'Cannot load Compendium: the server sent a reply this page cannot read.',
    );
    expect(plainError('Save failed: {"issues":[1]}')).toBe(
      'Save failed: the server sent a reply this page cannot read.',
    );
    // Markup in a sentence (not a page) and braces in a field reference stay.
    expect(plainError('Unknown markup tag <shiny>')).toBe('Unknown markup tag <shiny>');
    expect(plainError('Fill {1:text} first')).toBe('Fill {1:text} first');
  });

  it('turns a schema check failure into a plain message', () => {
    const failed = z.object({ permissions: z.object({}) }).safeParse({ permissions: null });
    expect(failed.success).toBe(false);
    expect(plainError(failed.error)).toBe(
      'The server sent data in an unexpected shape. Retry, or reload the page.',
    );
  });
});
