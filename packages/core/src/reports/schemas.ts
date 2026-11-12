import { z } from 'zod';
import { langSchema } from '../languages.js';

// UTF-16 offsets: never normalise reporter text before comparing selectors.
// Explicitly reject these characters; the control bytes are the intended match.
const forbidden =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u; // eslint-disable-line no-control-regex
export const reportText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !forbidden.test(s), 'Control and bidi characters are not allowed');
export const reportCategorySchema = z.enum([
  'wrong-value',
  'outdated',
  'wording',
  'translation',
  'missing',
  'other',
]);
export const reportStatusSchema = z.enum([
  'open',
  'triaged',
  'fixed',
  'closed',
  'rejected',
  'duplicate',
  'spam',
  'withdrawn',
]);
export const reportIdSchema = z.string().regex(/^r-[a-z2-7]{8}$/);
export const reportAnchorSchema = z
  .object({
    rev: z.string().regex(/^[a-f0-9]{16}$/),
    exact: reportText(4096).min(1),
    prefix: reportText(32),
    suffix: reportText(32),
    start: z.number().int().min(0).max(4095),
    end: z.number().int().min(1).max(4096),
    line: z.number().int().min(0).max(4096),
  })
  .strict()
  .refine((a) => a.end > a.start && a.end - a.start === a.exact.length, 'Invalid selector bounds');
export type ReportAnchor = z.infer<typeof reportAnchorSchema>;
const httpsUrl = reportText(2048)
  .url()
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password;
  }, 'An https URL is required');
export const reportVideoHosts = [
  'youtube.com',
  'youtu.be',
  'clips.twitch.tv',
  'streamable.com',
  'imgur.com',
  'i.imgur.com',
];
export const reportVideoSchema = httpsUrl.refine(
  (s) => reportVideoHosts.includes(new URL(s).hostname),
  'Use YouTube, Twitch clips, Streamable, or imgur; Discord links expire',
);
export const reportSubmissionSchema = z
  .object({
    request_id: z.string().uuid(),
    withdraw_secret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    viewed_hash: z.number().int().min(0).max(0xffffffff),
    // Optional only so already-stored requests from older clients can still retry.
    // The Worker requires both fields for every new report.
    owner_hash: z.number().int().min(0).max(0xffffffff).optional(),
    variant: z
      .string()
      .regex(/^(base|enhanced|override:\d+)$/)
      .optional(),
    lang: langSchema,
    seen_lang: langSchema.optional(),
    rev: z.string().regex(/^[a-f0-9]{16}$/),
    data_commit: z.string().regex(/^[a-f0-9]{40}$/),
    category: reportCategorySchema,
    note: reportText(1000).default(''),
    notes: z
      .array(
        z
          .object({
            category: reportCategorySchema,
            text: reportText(500),
            anchor: reportAnchorSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    source_url: httpsUrl.optional(),
    src: reportText(64).optional(),
    links: z.array(reportVideoSchema).max(2).default([]),
    turnstile: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.notes.every((n) =>
        n.anchor ? n.text.trim().length > 0 : n.text.trim().length > 0 || r.note.trim().length > 0,
      ),
    'Each mark needs a note',
  )
  .refine(
    (r) => r.notes.every((n) => !n.anchor || n.anchor.rev === r.rev),
    'Selectors must use the report revision',
  );
export type ReportSubmission = z.infer<typeof reportSubmissionSchema>;
export const reportActionSchema = z
  .object({
    expected_version: z.number().int().positive(),
    action: z.enum([
      'triage',
      'claim',
      'resolve',
      'confirmPublished',
      'reopen',
      'close',
      'reject',
      'duplicate',
      'spam',
      'reanchor',
      'closedNote',
    ]),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    publishable: z
      .string()
      .regex(/^[a-f0-9]{16,64}$/)
      .optional(),
    of: reportIdSchema.optional(),
    reason: z.enum(['not-an-issue', 'works-as-described', 'out-of-scope', 'unclear']).optional(),
    n: z.number().int().min(1).max(5).optional(),
    anchor: reportAnchorSchema.optional(),
    text: reportText(1000).optional(),
  })
  .strict();
