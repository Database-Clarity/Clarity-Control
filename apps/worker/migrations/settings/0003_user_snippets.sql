CREATE TABLE user_snippets (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  revision TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, label_id)
);
