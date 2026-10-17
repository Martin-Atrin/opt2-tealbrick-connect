-- 0011 (C230 R3 review): (1) `rev` becomes a per-account sequence, so a cursor never shows how much other accounts
-- received; (2) rows from other bots are kept for data apps (author kind bot) and never listed for agents;
-- (3) a share records when it began (set_at) and whether the owner included the log kept before it;
-- (4) one audit line per data_pull (app, account, dataset, row count; no text).
ALTER TABLE connect_channel_inbox ADD COLUMN sender_is_bot INTEGER NOT NULL DEFAULT 0;

UPDATE connect_channel_inbox SET rev = (
  SELECT COUNT(*) FROM connect_channel_inbox j WHERE j.account_id = connect_channel_inbox.account_id AND j.rev <= connect_channel_inbox.rev
);

-- Per-account counter. A row is never deleted while its account lives, so a number is never reused after the purge.
CREATE TABLE connect_account_rev (
  account_id TEXT PRIMARY KEY REFERENCES connect_accounts (id) ON DELETE CASCADE,
  last INTEGER NOT NULL
);
INSERT INTO connect_account_rev (account_id, last) SELECT account_id, MAX(rev) FROM connect_channel_inbox GROUP BY account_id;
DROP TABLE connect_inbox_rev;

ALTER TABLE connect_account_shares ADD COLUMN include_history INTEGER NOT NULL DEFAULT 0;

CREATE TABLE connect_data_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  product TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX connect_data_audit_at ON connect_data_audit (at);
