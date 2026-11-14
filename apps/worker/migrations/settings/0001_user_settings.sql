CREATE TABLE user_settings (
  id TEXT PRIMARY KEY NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
