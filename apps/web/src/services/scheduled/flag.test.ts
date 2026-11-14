// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { scheduledSwitch } from '../../../vite.config';
import { scheduledEnabled } from './flag';

const dir = mkdtempSync(join(tmpdir(), 'scheduled-switch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('scheduled changes build switch (I6)', () => {
  it('is OFF when config/scheduled.json is absent', () => {
    expect(scheduledSwitch(join(dir, 'missing.json'))).toBe(false);
  });
  it('follows a boolean "enabled"', () => {
    expect(scheduledSwitch(file('off.json', '{"enabled": false}'))).toBe(false);
    expect(scheduledSwitch(file('on.json', '{"enabled": true}'))).toBe(true);
  });
  it('fails the build on a malformed file instead of guessing', () => {
    expect(() => scheduledSwitch(file('string.json', '{"enabled": "yes"}'))).toThrow('boolean');
    expect(() => scheduledSwitch(file('empty.json', '{}'))).toThrow('boolean');
    expect(() => scheduledSwitch(file('null.json', 'null'))).toThrow('boolean');
    expect(() => scheduledSwitch(file('bad.json', '{'))).toThrow();
  });
  it('reads the built value: only "1" is ON', () => {
    expect(scheduledEnabled()).toBe(false);
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    expect(scheduledEnabled()).toBe(false);
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    expect(scheduledEnabled()).toBe(true);
  });
});
