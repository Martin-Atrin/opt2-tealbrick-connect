-- 0005: Buzz multi-relay (C73). The workspace relay list is a manifest setting (buzz_relays; the old buzz_relay_url is
-- read for one release as the first entry). Per agent, the owner can limit the agent to a subset of those relays:
-- one row = the chosen relays (JSON array of normalised wss URLs, workspace order); no row = all workspace relays.
CREATE TABLE connect_buzz_agent_relays (
  agent TEXT PRIMARY KEY,
  relays TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Scheduled posts keep the agent's optional `relays` argument (JSON array or NULL = all its relays at send time).
ALTER TABLE connect_buzz_scheduled ADD COLUMN relays TEXT;
