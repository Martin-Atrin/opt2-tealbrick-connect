-- 0009 (security sprint 1).
-- CON-01: scheduled Buzz posts are checked again when they are due. connect_agents keeps the slice status of each agent
-- ('active' | 'paused', from agentAdded / agentsChanged); a post of a paused or removed agent is never sent.
-- A claimed post is 'sending' (claimed_at set) until the relay answered: a crash never leaves an unsent row 'sent'.
ALTER TABLE connect_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'));

CREATE TABLE connect_buzz_scheduled_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  content TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  event_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  relays TEXT,
  claimed_at INTEGER
);
INSERT INTO connect_buzz_scheduled_new (id, agent, channel, content, send_at, status, event_id, detail, created_at, relays)
  SELECT id, agent, channel, content, send_at, status, event_id, detail, created_at, relays FROM connect_buzz_scheduled;
DROP TABLE connect_buzz_scheduled;
ALTER TABLE connect_buzz_scheduled_new RENAME TO connect_buzz_scheduled;
CREATE INDEX connect_buzz_scheduled_due ON connect_buzz_scheduled (status, send_at);
CREATE INDEX connect_buzz_scheduled_agent ON connect_buzz_scheduled (agent, status);

-- X-02: recipients a caller (agent or app) has sent to through a dynamic send tool on one account. A send tool to an
-- address not listed here needs `<tool>__first_contact` (hold family first_contact, owner approval).
CREATE TABLE connect_tool_contacts (
  caller TEXT NOT NULL,
  account TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  first_sent_at INTEGER NOT NULL,
  PRIMARY KEY (caller, account, address)
);

-- X-03: MCP tools the owner confirmed as read-only (the server's readOnlyHint alone is not trusted). Key = Connect tool name.
CREATE TABLE connect_tool_owner_reads (
  name TEXT PRIMARY KEY,
  set_at INTEGER NOT NULL
);
-- 1 = the MCP server claims this tool is read-only but Connect classes it higher (shown to the owner, who may confirm it).
ALTER TABLE connect_tools ADD COLUMN read_claim INTEGER NOT NULL DEFAULT 0;
