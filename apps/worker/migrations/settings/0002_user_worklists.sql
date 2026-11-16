CREATE TABLE user_worklists (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  meta_iv TEXT NOT NULL,
  meta_ct TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
);
