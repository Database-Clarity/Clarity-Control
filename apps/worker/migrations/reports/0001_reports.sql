PRAGMA foreign_keys = ON;
CREATE TABLE reports (
 id TEXT PRIMARY KEY, owner_hash INTEGER NOT NULL, viewed_hash INTEGER NOT NULL,
 variant TEXT NOT NULL, lang TEXT NOT NULL, seen_lang TEXT, rev TEXT NOT NULL, data_commit TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triaged','fixed','closed','rejected','duplicate','spam','withdrawn')),
 version INTEGER NOT NULL DEFAULT 1, category TEXT NOT NULL, note TEXT NOT NULL,
 source_url TEXT, src TEXT, reporter_id INTEGER, reporter_login TEXT,
 trust TEXT NOT NULL CHECK(trust IN ('anonymous','account','role')), withdraw_hash TEXT,
 request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 claimed_by TEXT, links TEXT NOT NULL DEFAULT '[]', files_count INTEGER NOT NULL DEFAULT 0, files_bytes INTEGER NOT NULL DEFAULT 0,
 duplicate_of TEXT, possible_duplicate_of TEXT, same_count INTEGER NOT NULL DEFAULT 0,
 fix_commit TEXT, fix_publishable TEXT, fixed_by TEXT, fixed_at INTEGER, published_at INTEGER, closed_note TEXT
);
CREATE INDEX reports_list ON reports(status,created_at,id);
CREATE INDEX reports_owner ON reports(owner_hash,lang,status);
CREATE INDEX reports_owner_page ON reports(owner_hash,lang,created_at DESC,id DESC,reporter_id);
CREATE INDEX reports_purge ON reports(status,updated_at,id,version);
CREATE INDEX reports_rollup_oldest ON reports(owner_hash,lang,status,category,trust,created_at,id);
CREATE INDEX reports_rollup_updated ON reports(owner_hash,lang,status,category,trust,updated_at DESC,id);
CREATE INDEX reports_mine ON reports(reporter_id,created_at);
CREATE TABLE notes (
 report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, n INTEGER NOT NULL CHECK(n BETWEEN 1 AND 5),
 category TEXT NOT NULL, text TEXT NOT NULL, exact TEXT, prefix TEXT, suffix TEXT, start INTEGER, end INTEGER, line INTEGER, whole INTEGER NOT NULL,
 rev TEXT, prev_rev TEXT, prev_exact TEXT, prev_prefix TEXT, prev_suffix TEXT, prev_start INTEGER, prev_end INTEGER,
 PRIMARY KEY(report_id,n)
);
CREATE TABLE events (report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, at INTEGER NOT NULL, actor_id INTEGER, actor_login TEXT, action TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT);
CREATE INDEX events_report ON events(report_id,at);
CREATE TABLE same (report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, principal_key TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(report_id,principal_key));
CREATE TABLE open_counts (owner_hash INTEGER NOT NULL, lang TEXT NOT NULL, n INTEGER NOT NULL CHECK(n >= 0), PRIMARY KEY(owner_hash,lang));
CREATE INDEX open_counts_active ON open_counts(owner_hash,lang,n) WHERE n>0;
-- Finite dimensions, independent of retained report history (8 x 6 x 3/group).
CREATE TABLE report_rollups (
 owner_hash INTEGER NOT NULL, lang TEXT NOT NULL, status TEXT NOT NULL, category TEXT NOT NULL, trust TEXT NOT NULL,
 n INTEGER NOT NULL CHECK(n>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_hash,lang,status,category,trust)
);
CREATE INDEX rollups_list ON report_rollups(owner_hash,lang,status,category,trust,n,created_at,updated_at);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('marker_rev','0'),('pause_all','0'),('pause_anonymous','0');
CREATE TABLE limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, cap INTEGER NOT NULL, expires_at INTEGER NOT NULL, CHECK(count <= cap)) WITHOUT ROWID;
CREATE INDEX limits_expiry ON limits(expires_at);
CREATE TABLE blocked (reporter_id INTEGER PRIMARY KEY, by TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT);
CREATE TABLE tombstones (id TEXT PRIMARY KEY, owner_hash INTEGER NOT NULL, lang TEXT NOT NULL, deleted_at INTEGER NOT NULL);
CREATE TABLE reporters (id INTEGER PRIMARY KEY, filed INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
-- Database triggers keep marker updates atomic even for maintenance SQL and restores.
CREATE TRIGGER reports_insert AFTER INSERT ON reports BEGIN
 INSERT INTO open_counts SELECT NEW.owner_hash,NEW.lang,1 WHERE NEW.status IN ('open','triaged') ON CONFLICT(owner_hash,lang) DO UPDATE SET n=n+1;
 UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='marker_rev';
 INSERT INTO reporters(id,filed,accepted,rejected,updated_at) SELECT NEW.reporter_id,1,NEW.status IN ('fixed','closed'),NEW.status='rejected',NEW.updated_at WHERE NEW.reporter_id IS NOT NULL ON CONFLICT(id) DO UPDATE SET filed=filed+1,accepted=accepted+excluded.accepted,rejected=rejected+excluded.rejected,updated_at=excluded.updated_at;
 INSERT INTO report_rollups VALUES(NEW.owner_hash,NEW.lang,NEW.status,NEW.category,NEW.trust,1,NEW.created_at,NEW.updated_at)
 ON CONFLICT(owner_hash,lang,status,category,trust) DO UPDATE SET n=n+1,created_at=MIN(created_at,excluded.created_at),updated_at=MAX(updated_at,excluded.updated_at);
END;
CREATE TRIGGER reports_rollup_update AFTER UPDATE OF owner_hash,lang,status,category,trust,created_at,updated_at ON reports
WHEN OLD.owner_hash<>NEW.owner_hash OR OLD.lang<>NEW.lang OR OLD.status<>NEW.status OR OLD.category<>NEW.category OR OLD.trust<>NEW.trust OR OLD.created_at<>NEW.created_at OR OLD.updated_at<>NEW.updated_at BEGIN
 DELETE FROM report_rollups WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust AND n=1;
 UPDATE report_rollups SET n=n-1,
 created_at=(SELECT created_at FROM reports WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust ORDER BY created_at,id LIMIT 1),
 updated_at=(SELECT updated_at FROM reports WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust ORDER BY updated_at DESC,id LIMIT 1)
 WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust;
 INSERT INTO report_rollups VALUES(NEW.owner_hash,NEW.lang,NEW.status,NEW.category,NEW.trust,1,NEW.created_at,NEW.updated_at)
 ON CONFLICT(owner_hash,lang,status,category,trust) DO UPDATE SET n=n+1,created_at=MIN(created_at,excluded.created_at),updated_at=MAX(updated_at,excluded.updated_at);
END;
CREATE TRIGGER reports_rollup_delete AFTER DELETE ON reports BEGIN
 DELETE FROM report_rollups WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust AND n=1;
 UPDATE report_rollups SET n=n-1,
 created_at=(SELECT created_at FROM reports WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust ORDER BY created_at,id LIMIT 1),
 updated_at=(SELECT updated_at FROM reports WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust ORDER BY updated_at DESC,id LIMIT 1)
 WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang AND status=OLD.status AND category=OLD.category AND trust=OLD.trust;
END;
CREATE TRIGGER reports_status AFTER UPDATE OF status ON reports WHEN OLD.status <> NEW.status BEGIN
 INSERT INTO open_counts SELECT NEW.owner_hash,NEW.lang,0 WHERE NEW.status IN ('open','triaged') ON CONFLICT(owner_hash,lang) DO NOTHING;
 UPDATE open_counts SET n=n-(OLD.status IN ('open','triaged'))+(NEW.status IN ('open','triaged')) WHERE owner_hash=NEW.owner_hash AND lang=NEW.lang;
 UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='marker_rev';
 UPDATE reporters SET accepted=accepted-(OLD.status IN ('fixed','closed'))+(NEW.status IN ('fixed','closed')), rejected=rejected-(OLD.status='rejected')+(NEW.status='rejected'),updated_at=NEW.updated_at WHERE id=NEW.reporter_id;
END;
CREATE TRIGGER reports_delete AFTER DELETE ON reports BEGIN
 UPDATE open_counts SET n=n-(OLD.status IN ('open','triaged')) WHERE owner_hash=OLD.owner_hash AND lang=OLD.lang;
 UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='marker_rev';
 INSERT OR IGNORE INTO tombstones VALUES(OLD.id,OLD.owner_hash,OLD.lang,unixepoch());
END;
