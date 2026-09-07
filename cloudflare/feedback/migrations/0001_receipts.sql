CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'unknown'))
);
CREATE INDEX receipts_time ON receipts(created_at);
CREATE INDEX receipts_ip_time ON receipts(ip_hash, created_at);
