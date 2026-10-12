-- 0007 (F15): inbound chat messages keep the provider user ids they mention (JSON array; NULL = before 0.4.0), so
-- channel_inbox can answer `mentions` and `mentionsMe` and an agent runner can wake on mentions only.
ALTER TABLE connect_channel_inbox ADD COLUMN mentions TEXT;
