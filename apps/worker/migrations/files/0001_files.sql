CREATE TABLE files (
 report_id TEXT NOT NULL, n INTEGER NOT NULL CHECK(n BETWEEN 1 AND 3), reporter_id INTEGER NOT NULL,
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 524288), sha256 TEXT NOT NULL,
 created_at INTEGER NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)=size), PRIMARY KEY(report_id,n)
);
CREATE INDEX files_age ON files(created_at,report_id);
CREATE TABLE limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, cap INTEGER NOT NULL, expires_at INTEGER NOT NULL, CHECK(count <= cap)) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('size_after','0');
