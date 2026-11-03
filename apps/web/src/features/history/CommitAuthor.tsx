import type { HistoryCommit } from '../../services/history';
import { When } from '../../ui/When';
import styles from './History.module.scss';

export function CommitAuthor({ entry, link = true }: { entry: HistoryCommit; link?: boolean }) {
  return (
    <span className={styles.author}>
      {entry.avatar && <img src={entry.avatar} alt="" referrerPolicy="no-referrer" />}
      {entry.login && link ? (
        <a href={`https://github.com/${encodeURIComponent(entry.login)}`}>{entry.login}</a>
      ) : (
        (entry.author ?? entry.login ?? 'Unknown author')
      )}
      {' · '}
      <When value={entry.date} fallback="Unknown date" />
    </span>
  );
}
