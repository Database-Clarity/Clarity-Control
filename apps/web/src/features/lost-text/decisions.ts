import { useSyncExternalStore } from 'react';
import type { User } from '../../services/api';
import { fingerprint, recordKey, type LostText } from './model';

/** Local dismissals: per account, in this browser only (record key -> record fingerprint). */
export const decisionsKey = (user: User | null | undefined) =>
  `clarity-lost-text:v1:${user?.id ?? 'anonymous'}`;

const changed = 'clarity-lost-text-decisions';

export function parseDecisions(raw: string | null): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((entry) => typeof entry !== 'string')
    )
      return {};
    return value as Record<string, string>;
  } catch {
    return {};
  }
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener(changed, notify);
  };
}

const parsed = new Map<string | null, Record<string, string>>();
/** The account's dismissals, kept in step with every writer in this tab and in others. */
export function useLostDecisions(user: User | null | undefined): Record<string, string> {
  const key = decisionsKey(user);
  const raw = useSyncExternalStore(subscribe, () => readRaw(key));
  let value = parsed.get(raw);
  if (!value) {
    if (parsed.size > 8) parsed.clear();
    parsed.set(raw, (value = parseDecisions(raw)));
  }
  return value;
}

/** Hides `record` for this account in this browser until its history changes. Throws when storage fails. */
export function dismissRecord(user: User | null | undefined, record: LostText) {
  const key = decisionsKey(user);
  const decisions = { ...parseDecisions(readRaw(key)), [recordKey(record)]: fingerprint(record) };
  localStorage.setItem(key, JSON.stringify(decisions));
  window.dispatchEvent(new Event(changed));
  return decisions;
}

export const isDismissed = (decisions: Record<string, string>, record: LostText) =>
  decisions[recordKey(record)] === fingerprint(record);
