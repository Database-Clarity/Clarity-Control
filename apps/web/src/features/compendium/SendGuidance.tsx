import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest } from '../../services/api';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import type { GuidanceDocument } from './guidanceSchema';

const endpoint = '/compendium/agent-guidance';
const stateSchema = z.object({
  revision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  document: z.unknown(),
});
const resultSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  url: z.string().url(),
});

export function SendGuidance({ document, ready }: { document: GuidanceDocument; ready: boolean }) {
  const user = useAuthStore((state) => state.user);
  const [revision, setRevision] = useState<string | null | undefined>();
  const [message, setMessage] = useState('');
  const [commit, setCommit] = useState<string>();
  const [sending, setSending] = useState(false);
  async function load() {
    setRevision(undefined);
    try {
      const response = await apiRequest(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = stateSchema.parse(await response.json());
      setRevision(result.revision);
      setMessage(
        result.revision
          ? 'A previous submission exists. Sending will replace it.'
          : 'No previous submission exists.',
      );
    } catch (error) {
      setMessage(`Send unavailable: ${errorMessage(error)}. Export a backup instead.`);
    }
  }
  useEffect(() => {
    if (user?.role === 'maintainer') void load();
  }, [user?.id, user?.role]);
  async function send() {
    if (revision === undefined) return;
    if (
      revision &&
      !window.confirm('Replace the existing agent guidance with your current examples and notes?')
    )
      return;
    setSending(true);
    setCommit(undefined);
    try {
      const response = await apiRequest(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, revision }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'Guidance or data branch changed. Reload status before sending.'
            : `HTTP ${response.status}`,
        );
      const result = resultSchema.parse(await response.json());
      setCommit(result.url);
      setRevision(undefined);
      setMessage('Guidance sent. Reload status before sending again.');
    } catch (error) {
      setRevision(undefined);
      setMessage(`Send failed: ${errorMessage(error)} Export a backup instead.`);
    } finally {
      setSending(false);
    }
  }
  if (user?.role !== 'maintainer')
    return (
      <p>Sign in as a maintainer to send guidance to agents. You can export a backup below.</p>
    );
  return (
    <div>
      <button disabled={!ready || sending || revision === undefined} onClick={() => void send()}>
        Send to agents
      </button>{' '}
      <button disabled={sending} onClick={() => void load()}>
        Reload send status
      </button>
      <p role="status">{message}</p>
      {commit && (
        <a href={commit} target="_blank" rel="noreferrer">
          View submitted commit
        </a>
      )}
    </div>
  );
}
