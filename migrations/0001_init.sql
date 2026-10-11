-- Connect baseline schema (one baseline, no imported history). SDK tables (tb_*) are created by the SDK.

-- One row per connected third-party account (scope type "account"; the row id is the scope instance id).
-- Per-agent access (tier) lives in the SDK scope store, never here.
CREATE TABLE connect_accounts (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,              -- e.g. "gmail" (Composio toolkit slug, catalog app id, MCP server slug, "buzz")
  source TEXT NOT NULL CHECK (source IN ('composio', 'catalog', 'mcp', 'channel')),
  kind TEXT NOT NULL CHECK (kind IN ('as_me', 'as_itself')),
  label TEXT NOT NULL,                -- owner-typed label, shown on the canvas summary
  owner_agent TEXT,                   -- agt_ id for kind = as_itself
  external_ref TEXT,                  -- Composio connected_account_id, catalog base URL, MCP server URL
  auth_config_id TEXT,                -- Composio auth config id
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'failed', 'revoked')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX connect_accounts_service ON connect_accounts (service, status);

-- One-time connect states (OAuth / Composio link). Only the SHA-256 of the state is stored.
CREATE TABLE connect_states (
  state_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('composio', 'mcp_oauth')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

-- Tool registry for the dynamic `tools` operation: one row per third-party tool Connect can call.
CREATE TABLE connect_tools (
  name TEXT PRIMARY KEY,              -- DynamicCatalogEntry.name ^[a-z][a-z0-9_]{1,47}$
  source TEXT NOT NULL CHECK (source IN ('composio', 'catalog', 'mcp')),
  service TEXT NOT NULL,
  upstream TEXT NOT NULL,             -- upstream tool slug / operation id
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema TEXT NOT NULL,         -- JSON Schema object (JSON text)
  crud TEXT NOT NULL,                 -- JSON array of CRUD actions
  effect TEXT NOT NULL,
  hold_family TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX connect_tools_service ON connect_tools (service);

-- Sealed app secrets (connector API keys, OAuth tokens, Buzz secret keys). AES-256-GCM, AAD = name.
CREATE TABLE connect_secrets (
  name TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One Buzz (Nostr) identity per agent ("as itself"). The secret key is in connect_secrets ("buzz:<agent>").
CREATE TABLE connect_buzz_identities (
  agent TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  profile_published_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Non-secret app settings chosen in the app UI (e.g. the Buzz relay URL).
CREATE TABLE connect_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agents of the workspace as the SDK reports them (events.agentAdded / agentRemoved from the instance slice).
CREATE TABLE connect_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
