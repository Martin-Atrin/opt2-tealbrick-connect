-- 0004: chat channels (Slack, Teams, Telegram, Discord; C58) and Buzz message actions.
-- A channel connection is a connect_accounts row (source 'channel', kind 'as_itself', owner_agent = the agent the bot
-- speaks for). Credentials live in the SDK app secrets (ctx.secrets) under `account:<id>`; never here.

-- Bot identity and non-secret settings per channel account.
CREATE TABLE connect_channel_bots (
  account_id TEXT PRIMARY KEY REFERENCES connect_accounts (id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  workspace TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  inbound_state TEXT NOT NULL DEFAULT 'stopped',
  inbound_detail TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Conversations seen (inbound) or discovered, per channel account.
CREATE TABLE connect_channel_conversations (
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation)
);

-- Inbound messages; `seq` is the agent's monotonic pull cursor (no timestamp cursor: HARVEST F7).
CREATE TABLE connect_channel_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (account_id, conversation, message_id)
);
CREATE INDEX connect_channel_inbox_account ON connect_channel_inbox (account_id, seq);

-- Messages this Connect sent (edit/delete/react only on own messages; Telegram self-echo check).
CREATE TABLE connect_channel_sent (
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation, message_id)
);

-- First contact done per (account, person): later DMs use channel_dm.
CREATE TABLE connect_channel_contacts (
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  first_sent_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, person_id)
);

-- Buzz: events the agent posted (edit/delete only own), and scheduled posts.
CREATE TABLE connect_buzz_sent (
  agent TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (agent, event_id)
);
CREATE TABLE connect_buzz_scheduled (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  content TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'failed', 'cancelled')),
  event_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX connect_buzz_scheduled_due ON connect_buzz_scheduled (status, send_at);
