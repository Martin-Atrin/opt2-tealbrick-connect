# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `connect`). Proposed next version: 0.6.0 (new operations and a migration).

## 0.6.0 - Unreleased

The shared data operation family and the dataset `messages` (request R3, knowledge S-9; decisions C230 and C169). Not tagged: Connect is under a stable soak and the lead decides the tag.

### Added
- Operations `data_accounts_list`, `data_catalog` and `data_pull` (agent audience until the app audience exists; effect read, crud read, idempotency none, no receipt). They serve apps only: an agent or a person gets `no_access` (403). One contract for Knowledge and Observer; a later dataset needs no new operation.
- Dataset `messages` (kind messages, delivery pull, contract `messages/1`, spec tag `spec-v0.1.42`): the inbound log of Slack, Teams, Telegram and Discord. Rows have id, conversation, thread, sentAt/editedAt (RFC 3339 UTC), deleted, author {kind, handle `<channel>:<value>`, display}, text (cut at 65 536, `truncated`), attachments (metadata, at most 32), `untrusted: true`. Cursor paging forward and backward, `anchor`, `exhausted`, `retryAfterS`, at most 200 rows and 2 MiB per page.
- Every page is validated against the vendored schema before it is returned. A mismatch answers `data_contract_violation` (500) and is logged without message text.
- Person operation `account_app_share {account, product, level: none | available | shared}` and, in Accounts, "Share with <app> (read only)" for each chat account (Knowledge, Observer). Default none. `available`: catalog only (names, kinds, approximate counts, history flag; no message text). `shared`: `data_pull` too. An app sees only accounts shared with its product. Every account an app cannot see answers the same `not_found`. `accounts_overview` lists the shares and the apps one can share with.
- Contract files `test/contracts/messages.1.schema.json` and `messages.1.json` (sha256 in `test/contracts/PROVENANCE.md`); the runtime schema `src/contracts/messages.1.schema.json` is a second byte copy (the image has no `test/`).
- Migration 0010: the inbound log gets `rev` (change counter), `edited_at`, `deleted` and `attachments`; tables `connect_inbox_rev` and `connect_account_shares`. Existing rows get `rev = seq`. There is no down migration; a failed update is rolled back by the SDK pre-update snapshot.

### Changed
- Disconnecting an account removes its app shares.
- `channel_inbox` (agents) no longer lists a message that the provider deleted.
- Dependencies: manifest 0.1.19 (was 0.1.18; `validateAgainstSchema`, `normalizeHandle`); miniapp-sdk, spec, conformance and ui unchanged. Lockfile integrity re-pinned.

### History in this phase
- No provider has a history reader in Connect yet. The inbound log (kept 30 days; apps need at least 7) is the only record. `data_catalog` says `history: false` for Slack, Teams, Telegram and Discord, and a backward pull answers `exhausted: true` with no rows. A forward pull from the start returns everything the log holds. Telegram bots are live-only.
- Edits, deletions and attachment metadata are supported by the log and the contract, but the four inbound parsers do not report them yet; messages arrive as new rows only.
- Buzz is not a connected account and is not part of the dataset in this phase.

### Gaps
- The SDK gives an app caller's manifest name, not its product id. A small table (`src/data/apps.ts`) maps the name to `knowledge` or `observer`; an unknown name sees nothing. A `caller.product` on the operation context would remove the table.
