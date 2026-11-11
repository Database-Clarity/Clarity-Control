CREATE TABLE files (
 report_id TEXT NOT NULL, n INTEGER NOT NULL CHECK(n BETWEEN 1 AND 3), reporter_id INTEGER NOT NULL,
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 524288), sha256 TEXT NOT NULL,
 created_at INTEGER NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)=size), PRIMARY KEY(report_id,n)
);
CREATE INDEX files_age ON files(created_at,report_id);
-- Permanent, content-free fence: even an upload that read an old open report
-- cannot insert after successful withdrawal, moderation, or physical deletion.
CREATE TABLE files_closed (report_id TEXT PRIMARY KEY);
CREATE TABLE limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, cap INTEGER NOT NULL, expires_at INTEGER NOT NULL, CHECK(count <= cap)) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('size_after','0');
CREATE TRIGGER files_closed_guard BEFORE INSERT ON files
WHEN EXISTS(SELECT 1 FROM files_closed WHERE report_id=NEW.report_id) BEGIN
 SELECT RAISE(ABORT,'REPORT_FILES_CLOSED');
END;
