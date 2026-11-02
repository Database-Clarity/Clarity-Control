import { useState } from 'react';

export function ArchiveIcon({ icon }: { icon?: string }) {
  const [failed, setFailed] = useState<string>();
  if (!icon || failed === icon)
    return (
      <span role="img" aria-label="Icon no longer available" title="Icon no longer available">
        ◇
      </span>
    );
  const url = icon.startsWith('/') ? `https://www.bungie.net${icon}` : icon;
  if (!/^https?:\/\//i.test(url))
    return (
      <span role="img" aria-label="Icon no longer available">
        ◇
      </span>
    );
  return <img src={url} alt="" onError={() => setFailed(icon)} style={{ width: 48, height: 48 }} />;
}
