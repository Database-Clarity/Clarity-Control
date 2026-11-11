import { FindIndex, type FindEntry, type FindOptions } from './index';

type Request =
  | { type: 'update'; entries: FindEntry[]; removed: number[] }
  | { type: 'query'; id: number; options: FindOptions };
const index = new FindIndex();
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.type === 'update') index.update(data.entries, data.removed);
  else self.postMessage({ id: data.id, ...index.query(data.options) });
};
