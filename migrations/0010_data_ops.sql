-- 0010 (C230 R3): the shared data_* op family. (1) The inbound log gets a change counter `rev` (the pull order of the
-- `messages` dataset: a new message, an edit or a deletion each take the next `rev`, so a forward cursor sees changes to
-- rows it already passed), edit time, a deleted flag and attachment metadata (names, mime types, sizes only). (2) The
-- owner shares a connected chat account with one app at a level: `available` (data_catalog only: names, kinds, counts)
-- or `shared` (data_pull too). No row = not shared.
ALTER TABLE connect_channel_inbox ADD COLUMN rev INTEGER;
ALTER TABLE connect_channel_inbox ADD COLUMN edited_at INTEGER;
ALTER TABLE connect_channel_inbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connect_channel_inbox ADD COLUMN attachments TEXT;
UPDATE connect_channel_inbox SET rev = seq;
CREATE INDEX connect_channel_inbox_rev ON connect_channel_inbox (account_id, rev);

-- Monotonic counter for `rev`: AUTOINCREMENT never reuses a number, even after the retention purge empties the log.
CREATE TABLE connect_inbox_rev (id INTEGER PRIMARY KEY AUTOINCREMENT);
INSERT INTO connect_inbox_rev (id) SELECT MAX(seq) FROM connect_channel_inbox HAVING COUNT(*) > 0;

CREATE TABLE connect_account_shares (
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('available', 'shared')),
  set_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product)
);
CREATE INDEX connect_account_shares_product ON connect_account_shares (product);
