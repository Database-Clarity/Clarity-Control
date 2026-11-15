import { parseMemberTexts, type MemberParse } from './api.parse';

self.onmessage = (event: MessageEvent<{ id: number; jobs: MemberParse[] }>) => {
  const { id, jobs } = event.data;
  try {
    self.postMessage({ id, members: parseMemberTexts(jobs) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
