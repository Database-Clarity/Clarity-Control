import { diffWords } from '../../ui/diff/diffWords';
self.onmessage = (event: MessageEvent<{ id: number; before: string; after: string }>) => {
  const { id, before, after } = event.data;
  self.postMessage({ id, parts: diffWords(before, after) });
};
