import { useState } from 'react';
import styles from './IdentityMenu.module.scss';

/** The GitHub picture for an account id: needs nothing but the id `/me` already carries. */
export const avatarUrl = (id: number | string) =>
  `https://avatars.githubusercontent.com/u/${encodeURIComponent(String(id))}?s=64&v=4`;

/**
 * The signed-in account's GitHub picture, round, over its login's first letter: the letter shows
 * while the picture loads and stays when the request fails (blocked, offline).
 */
export function AccountPicture({
  id,
  login,
  size = 'small',
}: {
  id: number | string;
  login: string;
  size?: 'small' | 'large';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = avatarUrl(id);
  return (
    <span className={styles.picture} data-size={size} aria-hidden="true">
      <span className={styles.initial}>{login.slice(0, 1).toUpperCase()}</span>
      {failed !== src && (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
