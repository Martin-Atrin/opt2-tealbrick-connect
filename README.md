# opt2-tealbrick-connect

Teal Brick opt2: Connect miniapp (Composio, MCP connectors, Tealbrick catalog, Channels), built on the Miniapp SDK.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Connect.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, Woodpecker secrets) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (`.woodpecker/secret-scan.yaml`, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## CI

Woodpecker CI (shared opt2 pipeline template from `opt2-tealbrick-platform`).

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Layout (P0 scaffold; built in P1 on the frozen Miniapp SDK)

| Path | Concern |
|---|---|
| `src/accounts/` | Connected accounts per agent and service. Tier per account: READ, READ/UPDATE (incl. create/send), READ/UPDATE/DELETE. Kind: "as me" or "as itself". |
| `src/sources/composio/` | Composio toolkits, auth configs, connected accounts, tool execution. |
| `src/sources/mcp/` | Custom and third-party remote MCP servers (client, outbound URL policy). |
| `src/sources/catalog/` | Tealbrick catalog: sha256-pinned OpenAPI specs with effect labels. |
| `src/oauth/` | MCP OAuth (RFC 9728, 8414, 7591, PKCE) and our own OAuth flows. |
| `src/channels/` | Buzz (one identity per agent), then Slack, Teams, Telegram, Discord. |
| `src/ui/` | Person UI opened through the bridge. |

Run the tests: `npm test` (Node 24 runs TypeScript directly).
