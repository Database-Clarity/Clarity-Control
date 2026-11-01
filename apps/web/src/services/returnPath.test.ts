import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberReturnPath, safeReturnPath, takeReturnPath } from './returnPath';

describe('safeReturnPath', () => {
  it('keeps in-app routes with a query', () => {
    expect(safeReturnPath('/t/12345')).toBe('/t/12345');
    expect(safeReturnPath('/t/12345?lang=de')).toBe('/t/12345?lang=de');
  });
  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
  });
  it('rejects the auth routes', () => {
    expect(safeReturnPath('/auth/callback')).toBe('/');
    expect(safeReturnPath('/auth/callback?session=x')).toBe('/');
    expect(safeReturnPath('/auth')).toBe('/');
  });
  it('rejects auth routes however the router would normalise them', () => {
    expect(safeReturnPath('/%61uth/callback?session=secret')).toBe('/');
    expect(safeReturnPath('/%41UTH/callback?session=secret')).toBe('/');
    expect(safeReturnPath('/AUTH/callback')).toBe('/');
    expect(safeReturnPath('/Auth')).toBe('/');
    expect(safeReturnPath('/auth/')).toBe('/');
    expect(safeReturnPath('/t/../auth/callback?session=secret')).toBe('/');
    expect(safeReturnPath('/t/%2e%2e/auth/callback')).toBe('/');
    expect(safeReturnPath('/./auth/callback')).toBe('/');
    expect(safeReturnPath('/t/1/../../auth')).toBe('/');
    expect(safeReturnPath('/auth#fragment')).toBe('/');
    expect(safeReturnPath('/t/..//auth/callback?session=secret')).toBe('/');
    expect(safeReturnPath('/.//auth/callback?session=secret')).toBe('/');
    expect(safeReturnPath('/t//../auth/callback')).toBe('/');
  });
  it('keeps ordinary routes that merely resemble auth or contain dot segments', () => {
    expect(safeReturnPath('/authors')).toBe('/authors');
    expect(safeReturnPath('/t/1/../2?lang=de')).toBe('/t/1/../2?lang=de');
    expect(safeReturnPath('/t/1?next=/auth/callback')).toBe('/t/1?next=/auth/callback');
  });
  it('rejects encoded slashes, backslashes, controls and malformed escapes', () => {
    expect(safeReturnPath('/t%2f..%2fauth/callback')).toBe('/');
    expect(safeReturnPath('/t%2F1')).toBe('/');
    expect(safeReturnPath('/t%5cevil')).toBe('/');
    expect(safeReturnPath('/t%5Cevil')).toBe('/');
    expect(safeReturnPath('/t/%0a1')).toBe('/');
    expect(safeReturnPath('/t/%00')).toBe('/');
    expect(safeReturnPath('/t/%7f')).toBe('/');
    expect(safeReturnPath('/t/%zz')).toBe('/');
    expect(safeReturnPath('/t/%')).toBe('/');
    expect(safeReturnPath('/t/%e0%a4%a')).toBe('/');
  });
  it('rejects missing and malformed values', () => {
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath('')).toBe('/');
    expect(safeReturnPath('t/1')).toBe('/');
    expect(safeReturnPath(42)).toBe('/');
    expect(safeReturnPath('/t/1\n/evil')).toBe('/');
    expect(safeReturnPath(`/${'a'.repeat(3000)}`)).toBe('/');
  });
});

describe('remembered return path', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the remembered path once, then clears it', () => {
    rememberReturnPath({ pathname: '/t/12345', search: '?lang=de' });
    expect(takeReturnPath()).toBe('/t/12345?lang=de');
    expect(takeReturnPath()).toBe('/');
  });
  it('does not store auth routes', () => {
    rememberReturnPath({ pathname: '/auth/callback', search: '?session=secret' });
    expect(takeReturnPath()).toBe('/');
  });
  it('never stores or returns an encoded callback with its session value', () => {
    rememberReturnPath({ pathname: '/%61uth/callback', search: '?session=secret' });
    expect(takeReturnPath()).toBe('/');
    rememberReturnPath({ pathname: '/t/../auth/callback', search: '?session=secret' });
    expect(takeReturnPath()).toBe('/');
    sessionStorage.setItem('clarity-editor-return-path', '/%61uth/callback?session=secret');
    expect(takeReturnPath()).toBe('/');
    rememberReturnPath({ pathname: '/t/..//auth/callback', search: '?session=secret' });
    expect(takeReturnPath()).toBe('/');
    sessionStorage.setItem('clarity-editor-return-path', '/.//auth/callback?session=secret');
    expect(takeReturnPath()).toBe('/');
  });
  it('falls back to / when storage throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => rememberReturnPath({ pathname: '/t/1', search: '' })).not.toThrow();
    expect(takeReturnPath()).toBe('/');
  });
});
