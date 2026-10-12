/**
 * Connect app definition for the Miniapp SDK (`defineApp`, SDK-API §3): one handler per manifest operation,
 * the dynamic `tools` family, public routes and events. Wire, auth, receipts, holds and scopes are SDK-owned.
 * Everything here is typed against the frozen contract (`@opt2-tealbrick/spec`).
 */

import type { AppSecrets, SdkAppDefinition, SdkOpContext, SdkPublicContext } from "@opt2-tealbrick/miniapp-sdk";
import type { CrudAction, DynamicCatalogEntry, DynamicResolution, DynamicSearchInput, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Db, DynamicHandlers, Handler, HandlerSpec, Json, OpContext, PublicHandler } from "@opt2-tealbrick/spec/sdk";

import { type Account, AccountStore, CONNECTION_KINDS, type ConnectionKind } from "./accounts.ts";
import { BuzzIdentities } from "./channels/buzz/identity.ts";
import { BuzzRelay } from "./channels/buzz/relay.ts";
import { CatalogCallError } from "./sources/catalog/http.ts";
import { CatalogError, CatalogSource } from "./sources/catalog/source.ts";
import { ComposioClient, ComposioError, type ComposioToolkit } from "./sources/composio/client.ts";
import { loadPolicies } from "./sources/composio/policy.ts";
import { ComposioSource, connectMode } from "./sources/composio/source.ts";
import { McpError } from "./sources/mcp/client.ts";
import { OAuthError } from "./sources/mcp/oauth.ts";
import { McpSource } from "./sources/mcp/source.ts";
import { ACCOUNT_ARGUMENT, ToolRegistry } from "./tools.ts";
import type { FetchLike } from "./util/http.ts";
import { NetPolicyError } from "./util/net-policy.ts";

export const PRODUCT_SCOPE = "account";
export const COMPOSIO_KEY = "COMPOSIO_API_KEY";
export const COMPOSIO_CALLBACK_PATH = "/oauth/composio/callback";
export const MCP_CALLBACK_PATH = "/oauth/mcp/callback";

/** Error constructor with the SDK `TbError` shape; main.ts passes the SDK class so thrown errors map to the envelope. */
export type ErrorCtor = new (code: string, message: string, httpStatus?: number) => Error;

export class ConnectError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface ConnectEnv {
  manifest: Manifest;
  migrationsDir: string;
  ErrorClass?: ErrorCtor;
  fetchImpl?: FetchLike;
  composioBaseUrl?: string;
  composioAllowedOrigins?: readonly string[];
  /** Data volume (catalog artifact cache). */
  dataDir?: string;
  /** Exact origins allowed for catalog/MCP base URLs without the public-address check (tests). */
  catalogAllowOrigins?: readonly string[];
  allowRelayOrigins?: readonly string[];
  /** Manifest setting `buzz_relay_url` (env CONNECT_BUZZ_RELAY_URL; settings reach apps only as env, S6). */
  buzzRelayUrl?: string | null;
}

/** The SDK passes `SdkOpContext` (publicUrl, workspace, scopes, secrets: C31) where the frozen types say OpContext. */
const extras = (ctx: OpContext): SdkOpContext => ctx as SdkOpContext;
type ServiceCtx = { db: Db; getKey(name: string): Promise<string | null>; secrets?: AppSecrets };

type Input = Record<string, unknown>;
const asInput = (value: Json): Input => (value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

interface Services {
  accounts: AccountStore;
  tools: ToolRegistry;
  secrets: AppSecrets;
  composio: ComposioSource;
  buzz: BuzzIdentities;
  relay: BuzzRelay;
  catalog: CatalogSource;
  mcp: McpSource;
}

export function createConnectApp(env: ConnectEnv): SdkAppDefinition {
  const Err: ErrorCtor = env.ErrorClass ?? ConnectError;
  const fail = (code: string, message: string, status = 400): never => {
    throw new Err(code, message, status);
  };
  const policies = loadPolicies();
  const toolkitCache = new ToolkitCache();
  let cache: { db: Db; services: Services } | null = null;

  /** Composio client from the current key: app-own key wins over the workspace default (SDK getKey, C12). */
  const composioClient = async (getKey: (name: string) => Promise<string | null>): Promise<ComposioClient> => {
    const apiKey = await getKey(COMPOSIO_KEY);
    if (!apiKey) throw new ComposioError("composio_key_missing", "Add your Composio API key on the workspace key page first.", 409);
    return new ComposioClient({
      apiKey,
      ...(env.composioBaseUrl ? { baseUrl: env.composioBaseUrl } : {}),
      ...(env.composioAllowedOrigins ? { allowedOrigins: env.composioAllowedOrigins } : {}),
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
    });
  };

  /** Services are bound to the SDK database handle (one process, one db). */
  const services = (ctx: ServiceCtx): Services => {
    const { db, getKey } = ctx;
    if (cache && cache.db === db) return cache.services;
    const secrets = ctx.secrets ?? fail("secrets_unavailable", "The SDK did not provide app secrets.", 500);
    const accounts = new AccountStore(db);
    const tools = new ToolRegistry(db);
    const composio = new ComposioSource({
      db,
      accounts,
      tools,
      policies,
      client: () => composioClient(getKey),
    });
    const buzz = new BuzzIdentities({
      db,
      secrets,
      relayUrl: env.buzzRelayUrl ?? null,
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
      ...(env.allowRelayOrigins ? { allowRelayOrigins: env.allowRelayOrigins } : {}),
    });
    const relay = new BuzzRelay(buzz, env.fetchImpl);
    const catalog = new CatalogSource({
      artifact: env.manifest.artifacts?.find((a) => a.id === "catalog"),
      dataDir: env.dataDir ?? "/data",
      accounts,
      tools,
      secrets,
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
      ...(env.catalogAllowOrigins ? { allowOrigins: env.catalogAllowOrigins } : {}),
    });
    const mcp = new McpSource({
      db,
      accounts,
      tools,
      secrets,
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
      ...(env.catalogAllowOrigins ? { allowOrigins: env.catalogAllowOrigins } : {}),
    });
    const built = { accounts, tools, secrets, composio, buzz, relay, catalog, mcp };
    cache = { db, services: built };
    return built;
  };

  /** Map module errors to the SDK error envelope. */
  const guard = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((error: unknown) => {
      if (error instanceof Err) throw error;
      if (error instanceof ComposioError) fail(error.code, error.message, error.status);
      if (error instanceof NetPolicyError) fail(error.code, error.message, 422);
      if (error instanceof CatalogError) fail(error.code, error.message, error.code === "catalog_app_unknown" || error.code === "tool_unknown" ? 404 : 400);
      if (error instanceof OAuthError) fail(error.code, error.message, 502);
      if (error instanceof McpError) fail(error.code, error.message, error.status && error.status < 500 ? 409 : 502);
      if (error instanceof CatalogCallError) fail(error.code, error.message, error.status && error.status < 500 ? 409 : 502);
      if (error instanceof Error && /^[a-z_]+(?::|$)/u.test(error.message)) fail(error.message.split(":")[0] ?? "connect_error", error.message, 400);
      throw error;
    });

  const accountView = (a: Account) => ({
    id: a.id,
    service: a.service,
    source: a.source,
    kind: a.kind,
    label: a.label,
    ownerAgent: a.ownerAgent,
    status: a.status,
    detail: a.detail,
  });

  /** Workspace id: from the SDK context (slice / person principal), else the verified grant. C12: Composio user_id. */
  const workspace = (ctx: OpContext): string =>
    extras(ctx).workspace ?? ctx.grant?.claims.ws ?? fail("workspace_unknown", "The workspace id is not known yet. Wait for the first workspace sync.", 503);
  const agentsOf = (db: Db): { id: string; name: string }[] =>
    db.prepare("SELECT id, name FROM connect_agents ORDER BY name, id").all().map((r) => ({ id: String(r.id), name: String(r.name) }));

  /** Accounts of one service this caller may use for a tool with the given CRUD class. */
  const usableAccounts = async (ctx: OpContext, s: Services, service: string, crud: readonly CrudAction[]): Promise<Account[]> => {
    const out: Account[] = [];
    for (const account of s.accounts.list({ service, status: "connected" })) {
      if (account.kind === "as_itself" && account.ownerAgent !== ctx.caller.id) continue;
      let allowed = true;
      for (const action of crud) {
        if (!(await ctx.scope.can(PRODUCT_SCOPE, account.id, action))) {
          allowed = false;
          break;
        }
      }
      if (allowed) out.push(account);
    }
    return out;
  };

  const dynamicTools: DynamicHandlers = {
    async catalog(query: DynamicSearchInput | null, ctx): Promise<DynamicCatalogEntry[]> {
      const s = services(ctx);
      return s.tools.search(query?.query ?? "", s.accounts.connectedServices(), query?.limit ?? 20);
    },
    async resolve(tool: string, ctx): Promise<DynamicResolution | null> {
      return services(ctx).tools.resolve(tool);
    },
    async call(tool, args, ctx): Promise<Json> {
      return guard(async () => {
        const s = services(ctx);
        const row = s.tools.get(tool) ?? fail("tool_unknown", `Unknown tool ${tool}. Search first.`, 404);
        const { [ACCOUNT_ARGUMENT]: selector, ...upstreamArgs } = args;
        const usable = await usableAccounts(ctx, s, row.service, row.crud);
        let account: Account | undefined;
        const wanted = str(selector);
        if (wanted) {
          const all = s.accounts.list({ service: row.service, status: "connected" });
          const match = all.find((a) => a.id === wanted) ?? all.find((a) => a.label.toLowerCase() === wanted.toLowerCase());
          if (!match) fail("account_unknown", `No connected ${row.service} account named "${wanted}".`, 404);
          account = usable.find((a) => a.id === match?.id) ?? fail("scope_denied", `Your access to "${match?.label}" does not allow this tool.`, 403);
        } else if (usable.length === 1) {
          account = usable[0];
        } else if (usable.length === 0) {
          fail("scope_denied", `You have no ${row.service} account with access for this tool. Ask the owner to raise your access in Connect.`, 403);
        } else {
          fail("account_ambiguous", `Pick one account with "${ACCOUNT_ARGUMENT}": ${usable.map((a) => a.label).join(", ")}.`, 409);
        }
        if (!account) return fail("scope_denied", "No usable account.", 403);
        ctx.receipt.summary(`${row.title} via ${account.label}`.slice(0, 280));
        ctx.receipt.meta({ subjectKind: account.kind, tool: row.upstream, service: row.service, account: account.label });
        let data: unknown;
        if (row.source === "composio") data = await s.composio.execute(account, row.upstream, upstreamArgs, workspace(ctx));
        else if (row.source === "catalog") data = await s.catalog.execute(account, row.name, upstreamArgs);
        else if (row.source === "mcp") data = await s.mcp.execute(account, row.upstream, upstreamArgs);
        else fail("source_not_ready", `${row.source} tools are not available yet.`, 501);
        return { account: account.label, untrusted: true, data: (data ?? null) as Json };
      });
    },
  };

  const handlers: Record<string, Handler | HandlerSpec> = {
    // ── agent ops ──
    accounts_list: {
      // Spans every account of the scope type; the handler filters with ctx.scope (SDK-API §3).
      scope: () => null,
      run: async (input, ctx) => {
      const s = services(ctx);
      const service = str(asInput(input).service);
      const readable = new Set(await ctx.scope.readable(PRODUCT_SCOPE));
      const accounts = s.accounts
        .list({ status: "connected", ...(service ? { service } : {}) })
        .filter((a) => readable.has(a.id) && (a.kind === "as_me" || a.ownerAgent === ctx.caller.id));
      const out = [];
      for (const a of accounts) {
        const canUpdate = await ctx.scope.can(PRODUCT_SCOPE, a.id, "update");
        const canDelete = await ctx.scope.can(PRODUCT_SCOPE, a.id, "delete");
        out.push({ id: a.id, label: a.label, service: a.service, kind: a.kind, access: canDelete ? "read_update_delete" : canUpdate ? "read_update" : "read" });
      }
      return { accounts: out };
      },
    },
    async buzz_identity(_input, ctx) {
      const s = services(ctx);
      const identity = s.buzz.get(ctx.caller.id);
      return { npub: identity?.npub ?? null, pubkey: identity?.pubkey ?? null, relay: s.buzz.relayUrl() };
    },

    async buzz_channels(_input, ctx) {
      return guard(async () => ({ channels: await services(ctx).relay.channels(ctx.caller.id) }));
    },
    async buzz_read(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const messages = await services(ctx).relay.read(ctx.caller.id, {
          channel: String(i.channel ?? ""),
          ...(typeof i.since === "number" ? { since: i.since } : {}),
          ...(typeof i.limit === "number" ? { limit: i.limit } : {}),
        });
        return { untrusted: true, messages };
      });
    },
    async buzz_post(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const channel = String(i.channel ?? "");
        const replyTo = str(i.replyTo);
        const root = str(i.threadRoot);
        ctx.receipt.summary(`Buzz post to channel ${channel.slice(0, 8)}…`);
        ctx.receipt.meta({ subjectKind: "as_itself", channel });
        return services(ctx).relay.post(ctx.caller.id, {
          channel,
          content: String(i.content ?? ""),
          ...(replyTo ? { replyTo: { id: replyTo, ...(root ? { root } : {}) } } : {}),
        });
      });
    },

    // ── person ops (app UI through the bridge launch) ──
    async services_search(input, ctx) {
      return guard(async () => {
        const query = (str(asInput(input).query) ?? "").toLowerCase();
        const matches = (slug: string, name: string) => !query || slug.includes(query) || name.toLowerCase().includes(query);
        let catalogAvailable = true;
        const apps = await services(ctx)
          .catalog.listApps()
          .catch((error: unknown) => {
            catalogAvailable = false;
            ctx.log.warn("catalog unavailable", { code: (error as { code?: string }).code ?? "error" });
            return [];
          });
        const catalog = apps
          .filter((a) => matches(a.service, a.name))
          .map((a) => ({ service: a.service, name: a.name, description: a.description, logo: null, source: "catalog", connectMode: "api_key", fields: a.fields, baseUrlExample: a.baseUrlExample }));
        if (!(await ctx.getKey(COMPOSIO_KEY))) return { composioKey: false, catalogAvailable, services: catalog };
        const toolkits = await toolkitCache.get(() => composioClient(ctx.getKey));
        const hits = toolkits
          .filter((t) => matches(t.slug, t.name))
          .slice(0, 30)
          .map((t) => ({ service: t.slug, name: t.name, description: t.description, logo: t.logo, source: "composio", connectMode: connectMode(t) }));
        return { composioKey: true, catalogAvailable, services: [...catalog, ...hits] };
      });
    },
    async accounts_overview(_input, ctx) {
      const s = services(ctx);
      return { accounts: s.accounts.list().map(accountView) };
    },
    async account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const service = str(i.service) ?? fail("service_required", "Pick a service.");
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const origin = extras(ctx).publicUrl ?? fail("public_origin_unknown", "The workspace door address is not known yet.", 503);
        const result = await s.composio.startConnect({
          service,
          label: str(i.label) ?? service,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
          workspaceId: workspace(ctx),
          callbackUrl: `${origin.replace(/\/+$/u, "")}/p/${env.manifest.id}${COMPOSIO_CALLBACK_PATH}`,
        });
        return { account: accountView(result.account), redirectUrl: result.redirectUrl };
      });
    },
    async catalog_account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const credentials = (i.credentials && typeof i.credentials === "object" ? i.credentials : {}) as Record<string, string>;
        const account = await s.catalog.connect({
          service: str(i.service) ?? fail("service_required", "Pick an app."),
          label: str(i.label) ?? String(i.service),
          baseUrl: str(i.baseUrl) ?? fail("base_url_required", "Enter the app's address."),
          credentials,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
        });
        await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
        return { account: accountView(account) };
      });
    },
    async mcp_account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const url = str(i.url) ?? fail("url_required", "Enter the MCP server address.");
        if (i.auth === "oauth") {
          const origin = extras(ctx).publicUrl ?? fail("public_origin_unknown", "The workspace door address is not known yet.", 503);
          const started = await s.mcp.startOAuth({
            label: str(i.label) ?? "MCP server",
            url,
            kind,
            ownerAgent: kind === "as_itself" ? agent : null,
            redirectUri: `${origin.replace(/\/+$/u, "")}/p/${env.manifest.id}${MCP_CALLBACK_PATH}`,
          });
          return { account: accountView(started.account), redirectUrl: started.redirectUrl };
        }
        const account = await s.mcp.connect({
          label: str(i.label) ?? "MCP server",
          url,
          headers: (i.headers && typeof i.headers === "object" ? i.headers : {}) as Record<string, unknown>,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
        });
        await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
        return { account: accountView(account) };
      });
    },
    async account_update(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const id = str(i.id) ?? fail("id_required", "Account id is required.");
        if (!s.accounts.get(id)) fail("account_not_found", "Account not found.", 404);
        return { account: accountView(s.accounts.update(id, { label: String(i.label ?? "") })) };
      });
    },
    async account_disconnect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const id = str(asInput(input).id) ?? fail("id_required", "Account id is required.");
        const account = s.accounts.get(id) ?? fail("account_not_found", "Account not found.", 404);
        const revoked =
          account.source === "composio"
            ? await s.composio.disconnect(account)
            : account.source === "catalog"
              ? await s.catalog.disconnect(account)
              : account.source === "mcp"
                ? await s.mcp.disconnect(account)
                : s.accounts.update(id, { status: "revoked" });
        return { account: accountView(revoked) };
      });
    },
    async tools_refresh(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const service = str(asInput(input).service) ?? fail("service_required", "Pick a service.");
        const connected = s.accounts.list({ service, status: "connected" });
        if (connected.length === 0) fail("service_not_connected", "Connect an account first.", 409);
        const first = connected[0];
        const tools =
          first?.source === "catalog" ? await s.catalog.syncTools(service) : first?.source === "mcp" ? await s.mcp.syncTools(first) : await s.composio.syncTools(service);
        return { service, tools };
      });
    },
    async buzz_identities_list(_input, ctx) {
      const s = services(ctx);
      const byAgent = new Map(s.buzz.list().map((i) => [i.agent, i]));
      return {
        relay: s.buzz.relayUrl(),
        agents: agentsOf(ctx.db).map((a) => ({ agent: a.id, name: a.name, identity: byAgent.get(a.id) ?? null })),
      };
    },
    async buzz_identities_generate(_input, ctx) {
      const s = services(ctx);
      const result = await s.buzz.generateAll(agentsOf(ctx.db));
      return { created: result.created, existing: result.existing };
    },
    async buzz_identity_rotate(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const id = str(asInput(input).agent) ?? fail("agent_required", "Pick an agent.");
        const agent = agentsOf(ctx.db).find((a) => a.id === id) ?? fail("agent_unknown", "Unknown agent.", 404);
        return { identity: await s.buzz.rotate(agent) };
      });
    },
    async buzz_profile_publish(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const one = str(asInput(input).agent);
        const targets = one ? [one] : s.buzz.list().map((i) => i.agent);
        const published = [];
        for (const agent of targets) published.push(await s.buzz.publishProfile(agent));
        return { published };
      });
    },
  };

  const composioCallback: PublicHandler = async (req, rawCtx) => {
    const ctx = rawCtx as SdkPublicContext;
    const url = new URL(req.url);
    const page = callbackPage;
    try {
      const s = services(ctx);
      const workspaceId = ctx.workspace ?? fail("workspace_unknown", "The workspace id is not known yet.", 503);
      const account = await s.composio.completeCallback({
        state: url.searchParams.get("state"),
        connectedAccountId: url.searchParams.get("connected_account_id") ?? url.searchParams.get("connectedAccountId"),
        workspaceId,
      });
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
      return page(true, "Connected", `${escapeHtml(account.label)} is connected. Set each agent's access in Connect.`, 200);
    } catch (error) {
      ctx.log.warn("composio callback failed", { code: (error as { code?: string }).code ?? "error" });
      const message = error instanceof Error ? error.message : "The connection did not complete.";
      return page(false, "Not connected", escapeHtml(message), 400);
    }
  };

  const mcpCallback: PublicHandler = async (req, rawCtx) => {
    const ctx = rawCtx as SdkPublicContext;
    const url = new URL(req.url);
    try {
      const account = await services(ctx).mcp.completeOAuth({
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
      });
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
      return callbackPage(true, "Connected", `${escapeHtml(account.label)} is connected. Set each agent's access in Connect.`, 200);
    } catch (error) {
      ctx.log.warn("mcp oauth callback failed", { code: (error as { code?: string }).code ?? "error" });
      return callbackPage(false, "Not connected", escapeHtml(error instanceof Error ? error.message : "The connection did not complete."), 400);
    }
  };

  return {
    manifest: env.manifest,
    handlers,
    dynamic: { tools: dynamicTools },
    publicRoutes: { [COMPOSIO_CALLBACK_PATH]: composioCallback, [MCP_CALLBACK_PATH]: mcpCallback },
    migrations: env.migrationsDir,
    // connect_agents mirrors slice agents (id, name) because handlers have no slice-agent read in the SDK; Connect needs
    // agent names for Buzz identities and the "as itself" picker (BSA-15: recorded as app data until the SDK exposes them).
    events: {
      async agentAdded(agent, ctx) {
        ctx.db
          .prepare("INSERT INTO connect_agents (id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
          .run(agent.id, agent.name.slice(0, 80), Date.now());
      },
      async agentRemoved(agent, ctx) {
        ctx.db.prepare("DELETE FROM connect_agents WHERE id = ?").run(agent.id);
      },
    },
  };
}

function callbackPage(ok: boolean, title: string, detail: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${detail}</p><p>You can close this window.</p><script>window.opener&&window.opener.postMessage({connect:${ok ? "true" : "false"}},"*")</script></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

/** Composio's toolkit list changes rarely; one fetch per hour serves every search. */
class ToolkitCache {
  #value: { at: number; toolkits: ComposioToolkit[] } | null = null;
  async get(client: () => Promise<ComposioClient>, now = Date.now()): Promise<ComposioToolkit[]> {
    if (this.#value && now - this.#value.at < 3_600_000) return this.#value.toolkits;
    const toolkits = await (await client()).listToolkits();
    this.#value = { at: now, toolkits };
    return toolkits;
  }
}
