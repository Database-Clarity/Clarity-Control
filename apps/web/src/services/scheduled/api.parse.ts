import { batchMemberSchema, type BatchMember } from '@clarity/core/schedule';

/** One member file read from raw: the hash it was requested for and its body. */
export interface MemberParse {
  hash: number;
  text: string;
}

/**
 * Parse and validate member files (batchMemberSchema, plus the path's hash). Runs in the worker
 * (api.worker.ts); tests and environments without workers call it directly. Throws on the first
 * invalid file: the editor never renders a body it could not validate.
 */
export function parseMemberTexts(jobs: readonly MemberParse[]): BatchMember[] {
  return jobs.map(({ hash, text }) => {
    const member = batchMemberSchema.parse(JSON.parse(text));
    if (member.hash !== hash)
      throw new Error(`Batch member file ${hash} holds tooltip ${member.hash}`);
    return member;
  });
}
