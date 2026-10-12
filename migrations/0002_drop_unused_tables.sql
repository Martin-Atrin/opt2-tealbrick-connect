-- 0002: remove tables no code uses (BSA-09, BSA-15).
-- connect_secrets: app secrets (connector keys, OAuth tokens, Buzz agent keys) live in the SDK app secrets (ctx.secrets,
--   C31), sealed by the SDK. 0001's comments that say "connect_secrets" are historical (an applied migration is
--   immutable: its sha256 is checked at boot).
-- connect_settings: the Buzz relay is now the manifest setting `buzz_relay_url` (env CONNECT_BUZZ_RELAY_URL).
DROP TABLE IF EXISTS connect_secrets;
DROP TABLE IF EXISTS connect_settings;
