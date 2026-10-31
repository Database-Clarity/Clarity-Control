import { useState } from 'react';
import { errorMessage } from '../../services/http';
import { emptyProgress, readProgress, type ReviewProgress } from './reviewProgress';

// Mount the queue with key=storageKey so identity changes cannot copy another user's state.
export function useReviewProgress(storageKey: string) {
  const [initial] = useState(() => {
    try {
      return { progress: readProgress(localStorage, storageKey), error: '' };
    } catch (error) {
      return { progress: emptyProgress(), error: errorMessage(error) };
    }
  });
  const [progress, setProgress] = useState(initial.progress);
  const [error, setError] = useState(initial.error);
  function update(update: (current: ReviewProgress) => ReviewProgress) {
    const next = update(progress);
    setProgress(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setError('');
    } catch (error) {
      setError(`Review progress is only in memory: ${errorMessage(error)}`);
    }
  }
  return { progress, update, error };
}
