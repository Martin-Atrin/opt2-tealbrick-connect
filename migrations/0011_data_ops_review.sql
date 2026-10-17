-- 0011 (C230 R3 review): (1) `rev` becomes a per-account sequence, so a cursor never shows how much other accounts
-- received; (2) rows from other bots are kept for data apps (author kind bot) and never listed for agents;
-- (3) a share records when it began (set_at) and whether the owner included the log kept before it;
-- (4) one audit line per data_* call (app, account, dataset, outcome, row count; no text); (5) a count of unmatched changes.
ALTER TABLE connect_channel_inbox ADD COLUMN sender_is_bot INTEGER NOT NULL DEFAULT 0;
-- Edits and deletions that name a message not in the log (older than the retention, from before the bot connected).
ALTER TABLE connect_channel_bots ADD COLUMN unmatched_changes INTEGER NOT NULL DEFAULT 0;

-- One pass (window function + UPDATE FROM, SQLite >= 3.33): a correlated COUNT(*) per row is quadratic.
WITH n AS (SELECT seq, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY rev) AS rn FROM connect_channel_inbox)
UPDATE connect_channel_inbox SET rev = n.rn FROM n WHERE connect_channel_inbox.seq = n.seq;

-- The retention purge deletes by received_at (and so does a share that starts at a time).
CREATE INDEX connect_channel_inbox_received ON connect_channel_inbox (received_at);

-- Per-account counter. A row is never deleted while its account lives, so a number is never reused after the purge.
CREATE TABLE connect_account_rev (
  account_id TEXT PRIMARY KEY REFERENCES connect_accounts (id) ON DELETE CASCADE,
  last INTEGER NOT NULL
);
INSERT INTO connect_account_rev (account_id, last) SELECT account_id, MAX(rev) FROM connect_channel_inbox GROUP BY account_id;
DROP TABLE connect_inbox_rev;

ALTER TABLE connect_account_shares ADD COLUMN include_history INTEGER NOT NULL DEFAULT 0;

-- One line per data_* call, also a refused one: who called, which op, the outcome (ok or the refusal code), and for a
-- successful pull how many rows. No text. `product` is the verified product (null while the SDK does not name it).
CREATE TABLE connect_data_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  op TEXT NOT NULL,
  outcome TEXT NOT NULL,
  caller_type TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  product TEXT,
  account_id TEXT,
  dataset TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX connect_data_audit_at ON connect_data_audit (at);
