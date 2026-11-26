-- Publishes an account acknowledged (web shell notice dismissed on every device).
-- account_id is the same opaque HMAC id as user_settings; op_id is a public publish opId.
CREATE TABLE publish_acks (
  account_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  acked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, op_id)
);
