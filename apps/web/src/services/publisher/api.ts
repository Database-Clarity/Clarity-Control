import { z } from 'zod';
import { apiRequest } from '../api';

/** What the Worker reports for one operation (GET /publish/status, fixed shape). */
export type RemoteStatus = 'pending' | 'done' | 'unchanged' | 'stale' | 'rejected' | 'failed';
export interface PublishAnswer {
  status: RemoteStatus;
  refusal?: string;
  regroupable?: false;
  /** A finished request with globals, when its receipt says which went live and why others did not. */
  globals?: { live: string[]; refused: { id: string; error: string }[] };
}
export const terminalStatuses = ['done', 'unchanged', 'stale', 'rejected', 'failed'] as const;

/** One operation's request: immutable, so a re-send is byte-identical. */
export interface PublishBody {
  opId: string;
  hashes: number[];
  expected: Record<string, string>;
  globals?: { id: string; expected: string }[];
}
export const publishBody = ({ opId, hashes, expected, globals }: PublishBody): PublishBody => ({
  opId,
  hashes,
  expected,
  ...(globals ? { globals: globals.map(({ id, expected }) => ({ id, expected })) } : {}),
});

/** A non-2xx answer. `status` 0 = the request never got an answer (offline, timeout, CORS). */
export class PublishHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The message is the Worker's own JSON `error`, not an edge page or a client-side reason. */
    readonly fromWorker = false,
    readonly code?: string,
  ) {
    super(message);
  }
}

const terminal = z.enum(terminalStatuses);
const acceptedSchema = z.object({ opId: z.string(), status: z.literal('pending') });
const completeSchema = z.object({ opId: z.string(), result: z.unknown() });
const statusSchema = z.object({
  operations: z.array(z.object({ opId: z.string(), status: z.string() })),
});

const requestTimeoutMs = 30_000;

async function send(path: string, init?: RequestInit): Promise<{ status: number; value: unknown }> {
  let response: Response;
  try {
    // A hung request must end (status 0 = unresolved, so the same opId is retried with backoff).
    response = await apiRequest(path, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (reason) {
    throw new PublishHttpError(0, reason instanceof Error ? reason.message : 'Network error');
  }
  const text = await response.text().catch(() => '');
  let value: unknown = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  if (!response.ok) {
    const error = z.object({ error: z.string(), details: z.unknown().optional() }).safeParse(value);
    const details = z.object({ code: z.string() }).safeParse(error.data?.details);
    throw new PublishHttpError(
      response.status,
      error.success ? error.data.error : text.slice(0, 200),
      error.success,
      details.data?.code,
    );
  }
  return { status: response.status, value };
}

/** Undefined when the receipt names no outcome: nothing is then known about its globals. */
function globalResult(result: unknown): PublishAnswer['globals'] {
  const parsed = z
    .object({
      globals: z.array(z.string()).optional(),
      globalRefusals: z.array(z.object({ id: z.string(), error: z.string() })).optional(),
    })
    .safeParse(result).data;
  return parsed && (parsed.globals || parsed.globalRefusals)
    ? { live: parsed.globals ?? [], refused: parsed.globalRefusals ?? [] }
    : undefined;
}

/**
 * Submits (or re-submits, byte-identical) one operation. 202 = queued; 200 = already finished, with the
 * terminal status recovered from the Worker's log. Anything else is a PublishHttpError.
 */
export async function postPublish(body: PublishBody): Promise<PublishAnswer> {
  const { status, value } = await send('/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(publishBody(body)),
  });
  if (status === 202) {
    if (!acceptedSchema.safeParse(value).success)
      throw new PublishHttpError(502, 'Unexpected publish response');
    return { status: 'pending' };
  }
  const complete = completeSchema.safeParse(value);
  if (!complete.success) throw new PublishHttpError(502, 'Unexpected publish response');
  const result = z
    .object({ status: terminal, code: z.unknown().optional(), error: z.unknown().optional() })
    .safeParse(complete.data.result);
  // A completed log whose status we do not understand is still a finished operation.
  const resolved = result.success ? result.data.status : 'failed';
  const error = result.data?.error;
  if (
    resolved === 'rejected' &&
    result.data?.code === 'selected-rows-changed' &&
    typeof error === 'string'
  )
    return { status: resolved, refusal: error, regroupable: false };
  // The Publisher records this terminal refusal before making any live change.
  const prefix = 'ConsumerOutputRejected: ';
  return resolved === 'rejected' && typeof error === 'string' && error.startsWith(prefix)
    ? { status: resolved, refusal: error.slice(prefix.length) }
    : {
        status: resolved,
        ...(body.globals ? { globals: globalResult(complete.data.result) } : {}),
      };
}

/** `unknown` = the Worker has neither a request nor a log for this opId (a lost 202, or a typo). */
export async function getPublishStatus(opId: string): Promise<RemoteStatus | 'unknown'> {
  const { value } = await send(`/publish/status?opId=${encodeURIComponent(opId)}`);
  const parsed = statusSchema.safeParse(value);
  const entry = parsed.success ? parsed.data.operations.find((o) => o.opId === opId) : undefined;
  if (!entry) throw new PublishHttpError(502, 'Unexpected status response');
  if (entry.status === 'pending' || entry.status === 'unknown') return entry.status;
  const known = terminal.safeParse(entry.status);
  return known.success ? known.data : 'failed';
}

export async function kickPublish(opId: string): Promise<void> {
  await send('/publish/kick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opId }),
  });
}
