import { z } from 'zod';
import {
  currentSaveOutcome,
  currentSavePartBytes,
  currentSaveStagePaths,
  tooltipSchema,
} from '@clarity/core';
import { conflictSchema, type Change, type SaveResult } from '../api';
import { apiRequest, failure } from '../apiAuth';
import { assertNoGlobalAggregates } from '../globalsFlag';

const rawSource = 'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database';
const route = '/save/stage';

export async function readCurrentSaveOutcome(requestId: string) {
  const response = await apiRequest(`${route}?requestId=${encodeURIComponent(requestId)}`);
  if (response.status === 404) return null;
  if (!response.ok) return failure(response);
  return currentSaveOutcome.parse(await response.json());
}

async function readSaved(path: string) {
  const response = await fetch(`${rawSource}/${path}`, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Saved data is still loading (HTTP ${response.status})`);
  return response.json();
}

export async function readStagedSavedTooltips(commit: string, hashes: readonly number[]) {
  const tooltips = [];
  for (let start = 0; start < hashes.length; start += 16) {
    const group = await Promise.all(
      hashes.slice(start, start + 16).map(async (hash) => {
        const tooltip = tooltipSchema.parse(await readSaved(`${commit}/tooltips/${hash}.json`));
        if (tooltip.hash !== hash) throw new Error('Saved tooltip identity changed');
        return tooltip;
      }),
    );
    tooltips.push(...group);
  }
  return tooltips;
}

async function post(value: unknown) {
  const response = await apiRequest(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    if (error.success) throw new Error(error.data.error);
    return failure(response);
  }
  return response.json();
}

export async function stageCurrentSave(
  requestId: string,
  changes: Change[],
  message: string,
  noTranslationImpact: boolean,
  proceed: () => boolean,
  progress: (uploaded: number | null) => void,
): Promise<SaveResult> {
  const hashes = changes.map(({ hash }) => hash);
  assertNoGlobalAggregates(hashes);
  const checkSession = () => {
    if (!proceed()) throw new Error('Your login or drafts changed. The remaining drafts are kept.');
  };
  const bytes = new TextEncoder().encode(JSON.stringify({ changes, message, noTranslationImpact }));
  let parts = 0;
  for (let start = 0; start < bytes.length; start += currentSavePartBytes) {
    checkSession();
    const chunk = bytes.subarray(start, start + currentSavePartBytes);
    const content = btoa(String.fromCharCode(...chunk));
    const accepted = z
      .object({ accepted: z.number() })
      .parse(await post({ requestId, part: parts, content }));
    if (accepted.accepted !== parts)
      throw new Error('The save parts arrived out of order. Retry from your drafts.');
    parts++;
    progress(
      Math.floor((changes.length * Math.min(start + chunk.length, bytes.length)) / bytes.length),
    );
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  checkSession();
  z.object({ queued: z.literal(true) }).parse(await post({ requestId, parts, digest }));
  progress(null);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    checkSession();
    const result = await readCurrentSaveOutcome(requestId);
    checkSession();
    if (!result) throw new Error('The queued save could not be found. Your drafts are kept.');
    if (result.status === 'saved')
      return {
        kind: 'saved',
        ...result,
        tooltips: await readStagedSavedTooltips(result.commit, hashes),
      };
    if (result.status === 'failed') return { kind: 'retry', error: result.error };
    if (result.status === 'conflicts') {
      const raw = await readSaved(`${result.head}/${currentSaveStagePaths.conflicts(requestId)}`);
      const { conflicts } = z.object({ conflicts: z.array(conflictSchema) }).parse(raw);
      return { kind: 'conflicts', conflicts };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(
    'These edits are still landing. Your drafts will clear when the save is confirmed.',
  );
}
