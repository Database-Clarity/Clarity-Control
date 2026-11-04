import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest } from '../../services/api';
import { guidanceDiagnostic as errorMessage } from './guidanceDiagnostic';
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
  url: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:'),
});

export function SendGuidance({
  document,
  ready,
  onStatus,
  onSend,
}: {
  document: GuidanceDocument;
  ready: boolean;
  onStatus?(status: string | null): void;
  onSend?(): void;
}) {
  const user = useAuthStore((state) => state.user);
  const [revision, setRevision] = useState<string | null | undefined>();
  const [message, setMessage] = useState('');
  const [commit, setCommit] = useState<string>();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sentDocument, setSentDocument] = useState<GuidanceDocument>();
  useEffect(() => {
    onStatus?.(
      user?.role !== 'maintainer'
        ? null
        : sending
          ? 'Sending guidance…'
          : failed
            ? 'Guidance delivery needs attention'
            : commit
              ? document === sentDocument
                ? 'Guidance sent to agents'
                : 'New browser edits; send to agents again'
              : null,
    );
  }, [onStatus, user?.role, sending, failed, commit, document, sentDocument]);
  async function load() {
    setRevision(undefined);
    setCommit(undefined);
    setFailed(false);
    setMessage('Loading send status…');
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
      setFailed(true);
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
    setMessage('Sending guidance…');
    setFailed(false);
    setCommit(undefined);
    try {
      onSend?.();
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
      setSentDocument(document);
      setCommit(result.url);
      setRevision(undefined);
      setMessage('Guidance sent. Reload status before sending again.');
    } catch (error) {
      setFailed(true);
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
      <p role={failed ? 'alert' : 'status'}>{message}</p>
      {commit && (
        <a href={commit} target="_blank" rel="noreferrer">
          View submitted commit
        </a>
      )}
    </div>
  );
}
