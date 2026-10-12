-- 0006: workspace sender identities (C86). One row per channel: the identity companion APPS send from (an agent caller
-- always keeps its own). channel = 'buzz' (account NULL: the Buzz identity with key 'workspace') or a chat service
-- (account = the connected channel account the owner picked). No row = refusal no_sender_identity for app callers.
CREATE TABLE connect_senders (
  channel TEXT PRIMARY KEY,
  account TEXT,
  label TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
