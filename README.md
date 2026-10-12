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

## Layout

| Path | Concern |
|---|---|
| `tealbrick.manifest.json` | The only description of the app (operations, `account` scope with tiers, key requirement, public route, catalog artifact pin). |
| `src/app.ts` | App definition for the Miniapp SDK: one handler per operation, the dynamic `tools` family, the Composio callback, events. |
| `src/accounts.ts` | Connected accounts (several per service). Per-agent access lives in the SDK scope store: READ, READ/UPDATE (incl. create/send), READ/UPDATE/DELETE. Kind "as me" or "as itself". |
| `src/tools.ts`, `src/effect.ts` | Tool registry behind `connect__tools_search` / `connect__tools_call`; effect and tier classification. |
| `src/sources/composio/` | Composio client (key only to `*.composio.dev`), verified connect flow, tool sync, policies (`policies/composio/`). |
| `src/channels/buzz/` | One Buzz (Nostr) identity per agent, created for all agents in one owner action; sealed keys; allowlisted signing. |
| `src/secrets.ts` | Sealed app secrets (AES-256-GCM, AAD = name). |
| `scripts/catalog-build.ts` | Builds the Tealbrick catalog artifact (sha256-pinned, scrubbed) attached to a GitHub release. |
| `scripts/conformance.ts` | Connect checks the real suite does not cover (app files, Composio policies); `pnpm conformance` runs `tb-conformance app` first. |

## Develop

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm gen && pnpm conformance
```

The image follows the template pattern (tsc to `dist/`, pnpm, manifest at `/opt/tb`); `node src/main.ts` runs the sources directly for development. The app starts only on `@opt2-tealbrick/miniapp-sdk`.
