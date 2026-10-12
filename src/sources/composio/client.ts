/**
 * Composio REST client (harvest: v1 provider-health.ts:250-900, app.ts:274-302; HARVEST §A).
 * - The API key is sent only to `https://*.composio.dev` (or an exact test origin passed by the caller).
 * - Catalog / accounts / auth configs on `/api/v3.1`; link and execute on `/api/v3` (as v1 used in production).
 * - Every request: timeout, size cap, no redirects, retries for GET (util/http.ts). Errors are typed and redacted.
 * - `user_id` is the workspace id (DECISION-LOG C12), never a literal.
 */
import { type FetchLike, requestJson, UpstreamError } from "../../util/http.ts";

export const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";

/** Schemes where the end user types a key on the Composio link page (Connect can create the auth config). */
export const USER_KEY_SCHEMES = ["API_KEY", "BEARER_TOKEN", "BASIC"] as const;
/** Schemes that need an owner-created custom auth config (OAuth app credentials) when no managed auth exists. */
export const OWNER_CONFIGURED_SCHEMES = [
  "OAUTH2", "OAUTH1", "OAUTH1A", "DCR_OAUTH", "S2S_OAUTH2", "GOOGLE_SERVICE_ACCOUNT", "SERVICE_ACCOUNT", "BASIC_WITH_JWT",
] as const;

export function allowedComposioOrigin(value: string, extraOrigins: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:" && (host === "composio.dev" || host.endsWith(".composio.dev"))) return true;
  return extraOrigins.includes(url.origin);
}

/** What Composio (or the network) answered, for log lines only. Never shown to the person. */
export interface UpstreamDetail {
  code: string;
  status: number | null;
  /** Redacted, truncated upstream text. */
  detail: string;
}

export class ComposioError extends Error {
  readonly code: string;
  readonly status: number;
  /** Set when the error came from an upstream answer: the log line carries it, the message stays plain. */
  readonly upstream: UpstreamDetail | undefined;
  constructor(code: string, message: string, status = 502, upstream?: UpstreamDetail) {
    super(message);
    this.name = "ComposioError";
    this.code = code;
    this.status = status;
    this.upstream = upstream;
  }
}

/** Plain text for the person; the raw upstream answer goes to the log only. */
const PLAIN_UPSTREAM: Record<string, string> = {
  composio_key_rejected: "Composio rejected the API key. Check the key on the workspace key page.",
  composio_not_found: "Composio does not know that item.",
  composio_timeout: "Composio took too long to answer. Try again.",
  composio_unreachable: "Composio could not be reached. Try again.",
  composio_response_too_large: "Composio sent an answer that was too large. Try again.",
};
const PLAIN_UPSTREAM_DEFAULT = "Composio could not finish that request. Try again.";

export function isAliasCollision(upstream: UpstreamDetail | undefined): boolean {
  return upstream !== undefined && (upstream.status === 400 || upstream.status === 409) && /alias/iu.test(upstream.detail) && /already in use|already exists/iu.test(upstream.detail);
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  noAuth: boolean;
  authSchemes: string[];
  managedAuthSchemes: string[];
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  inputParameters: Record<string, unknown>;
  tags: string[];
}

export interface ComposioConnectedAccount {
  id: string;
  status: string;
  toolkit: string | null;
  userId: string | null;
  authConfigId: string | null;
}

export interface ComposioAuthConfig {
  id: string;
  toolkit: string | null;
  authScheme: string | null;
  composioManaged: boolean | null;
  enabled: boolean;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).map((s) => s.trim().toUpperCase()).filter(Boolean) : []);
const items = (body: unknown): unknown[] => {
  const r = rec(body);
  if (Array.isArray(r?.items)) return r.items;
  if (Array.isArray(r?.data)) return r.data;
  return [];
};

export function parseToolkit(value: unknown): ComposioToolkit | null {
  const r = rec(value);
  const slug = str(r?.slug)?.toLowerCase();
  if (!r || !slug) return null;
  const meta = rec(r.meta) ?? {};
  const authDetails = Array.isArray(r.auth_config_details) ? r.auth_config_details : [];
  const authSchemes = [
    ...strings(r.auth_schemes),
    ...authDetails.map((d) => str(rec(d)?.mode)?.toUpperCase()).filter((s): s is string => Boolean(s)),
  ];
  return {
    slug,
    name: str(r.name) ?? slug,
    description: (str(meta.description) ?? str(r.description) ?? "").slice(0, 500),
    logo: str(meta.logo) ?? null,
    categories: Array.isArray(meta.categories) ? meta.categories.map((c) => str(rec(c)?.name) ?? String(c)).slice(0, 5) : [],
    noAuth: r.no_auth === true,
    authSchemes: [...new Set(authSchemes)],
    managedAuthSchemes: strings(r.composio_managed_auth_schemes),
  };
}

export function parseTool(value: unknown): ComposioTool | null {
  const r = rec(value);
  const slug = str(r?.slug);
  if (!r || !slug) return null;
  const toolkit = str(rec(r.toolkit)?.slug) ?? str(r.toolkit_slug) ?? slug.split("_")[0] ?? "";
  return {
    slug,
    name: str(r.name) ?? slug,
    description: (str(r.description) ?? "").slice(0, 1000),
    toolkit: toolkit.toLowerCase(),
    inputParameters: rec(r.input_parameters) ?? { type: "object", properties: {} },
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
  };
}

export function parseConnectedAccount(value: unknown): ComposioConnectedAccount | null {
  const r = rec(value);
  const id = str(r?.id) ?? str(r?.nanoid);
  if (!r || !id) return null;
  return {
    id,
    status: (str(r.status) ?? "UNKNOWN").toUpperCase(),
    toolkit: str(rec(r.toolkit)?.slug)?.toLowerCase() ?? null,
    userId: str(r.user_id) ?? null,
    authConfigId: str(rec(r.auth_config)?.id) ?? str(r.auth_config_id) ?? null,
  };
}

export function parseAuthConfig(value: unknown): ComposioAuthConfig | null {
  const r = rec(value);
  const nested = rec(r?.auth_config);
  const source = nested && !str(r?.id) ? nested : r;
  const id = str(source?.id) ?? str(source?.nanoid);
  if (!source || !id) return null;
  const managed = source.is_composio_managed;
  return {
    id,
    toolkit: str(rec(source.toolkit)?.slug)?.toLowerCase() ?? str(source.toolkit_slug)?.toLowerCase() ?? null,
    authScheme: str(source.auth_scheme)?.toUpperCase() ?? null,
    composioManaged: typeof managed === "boolean" ? managed : null,
    enabled: str(source.status)?.toUpperCase() !== "DISABLED" && source.is_disabled !== true,
  };
}

export interface ComposioClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Exact extra origins (tests / fixtures only). */
  allowedOrigins?: readonly string[];
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export class ComposioClient {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #linkBase: string;
  readonly #fetch: FetchLike | undefined;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(options: ComposioClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey || !/^[\x21-\x7E]+$/u.test(apiKey)) throw new ComposioError("composio_key_invalid", "The Composio API key is empty or malformed.", 400);
    const base = (options.baseUrl ?? COMPOSIO_BASE_URL).replace(/\/+$/u, "");
    if (!allowedComposioOrigin(base, options.allowedOrigins)) {
      throw new ComposioError("composio_base_url_not_allowed", "The Composio base URL must be an https://*.composio.dev address.", 400);
    }
    this.#apiKey = apiKey;
    this.#base = base;
    this.#linkBase = base.replace(/\/v3\.1$/u, "/v3");
    this.#fetch = options.fetchImpl;
    this.#sleep = options.sleep;
  }

  async #call<T>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, timeoutMs?: number): Promise<T> {
    try {
      return await requestJson<T>({
        method,
        url,
        body,
        headers: { "x-api-key": this.#apiKey },
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
        ...(this.#sleep ? { sleep: this.#sleep } : {}),
      });
    } catch (error) {
      if (error instanceof UpstreamError) {
        const code = error.code === "upstream_unauthorized" ? "composio_key_rejected" : error.code.replace(/^upstream_/u, "composio_");
        const upstream: UpstreamDetail = { code: error.code, status: error.status, detail: error.message.slice(0, 1000) };
        const collision = isAliasCollision(upstream);
        throw new ComposioError(
          collision ? "composio_alias_in_use" : code,
          collision ? "That sign-in could not start. Try again." : (PLAIN_UPSTREAM[code] ?? PLAIN_UPSTREAM_DEFAULT),
          error.code === "upstream_unauthorized" ? 401 : 502,
          upstream,
        );
      }
      throw error;
    }
  }

  async #paged(path: string, params: Record<string, string>, maxPages = 20): Promise<unknown[]> {
    const out: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams(params);
      if (cursor) query.set("cursor", cursor);
      const body = await this.#call<unknown>("GET", `${this.#base}${path}?${query}`);
      out.push(...items(body));
      const next = str(rec(body)?.next_cursor);
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return out;
  }

  /** Cheap authenticated probe: a key the API rejects throws `composio_key_rejected`. */
  async probeKey(): Promise<void> {
    await this.#call("GET", `${this.#base}/toolkits?limit=1`);
  }

  async listToolkits(): Promise<ComposioToolkit[]> {
    const raw = await this.#paged("/toolkits", { limit: "1000", sort_by: "usage", managed_by: "all", include_deprecated: "false" });
    return raw.map(parseToolkit).filter((t): t is ComposioToolkit => t !== null);
  }

  async getToolkit(slug: string): Promise<ComposioToolkit> {
    const toolkit = parseToolkit(await this.#call("GET", `${this.#base}/toolkits/${encodeURIComponent(slug)}`));
    if (!toolkit) throw new ComposioError("composio_toolkit_not_found", `Composio toolkit ${slug} was not found.`, 404);
    return toolkit;
  }

  async listTools(toolkit: string): Promise<ComposioTool[]> {
    const raw = await this.#paged("/tools", { toolkit_slug: toolkit, toolkit_versions: "latest", limit: "1000" }, 10);
    return raw.map(parseTool).filter((t): t is ComposioTool => t !== null);
  }

  async listAuthConfigs(toolkit: string): Promise<ComposioAuthConfig[]> {
    const raw = await this.#paged("/auth_configs", { toolkit_slug: toolkit, limit: "100" }, 3);
    return raw.map(parseAuthConfig).filter((c): c is ComposioAuthConfig => c !== null);
  }

  /**
   * Prefer an enabled custom auth config, then a managed one; else create managed auth (or custom auth for user-key
   * schemes). OAuth toolkits without managed auth need an owner-created config: `composio_auth_config_required`.
   */
  async getOrCreateAuthConfig(toolkit: ComposioToolkit): Promise<string> {
    if (toolkit.noAuth) throw new ComposioError("composio_toolkit_no_auth", `${toolkit.name} needs no sign-in.`, 409);
    const configs = (await this.listAuthConfigs(toolkit.slug)).filter(
      (c) => c.enabled && (c.toolkit === null || c.toolkit === toolkit.slug),
    );
    const custom = configs.find(
      (c) => c.composioManaged === false && (c.authScheme === null || toolkit.authSchemes.length === 0 || toolkit.authSchemes.includes(c.authScheme)),
    );
    if (custom) return custom.id;
    const managed = configs.find((c) => c.composioManaged === true) ?? configs.find((c) => c.composioManaged === null);
    if (managed) return managed.id;
    const usesManaged = toolkit.managedAuthSchemes.length > 0 || toolkit.authSchemes.length === 0;
    const userKeyScheme = toolkit.authSchemes.find((s) => (USER_KEY_SCHEMES as readonly string[]).includes(s));
    if (!usesManaged && !userKeyScheme) {
      throw new ComposioError(
        "composio_auth_config_required",
        `${toolkit.name} needs an OAuth app configured in the Composio dashboard before it can be connected.`,
        409,
      );
    }
    const created = await this.#call<unknown>("POST", `${this.#base}/auth_configs`, {
      toolkit: { slug: toolkit.slug },
      auth_config: usesManaged
        ? { type: "use_composio_managed_auth", credentials: {}, restrict_to_following_tools: [] }
        : { type: "use_custom_auth", authScheme: userKeyScheme, credentials: {}, restrict_to_following_tools: [] },
    });
    const id = parseAuthConfig(created)?.id;
    if (!id) throw new ComposioError("composio_auth_config_create_failed", `Composio did not return an auth config id for ${toolkit.slug}.`);
    return id;
  }

  /** Start a hosted connect link. `alias` = the owner's label; the state is our one-time value (only its hash is stored). */
  async createLink(input: { authConfigId: string; userId: string; alias: string; callbackUrl: string; state: string }): Promise<{
    connectedAccountId: string | null;
    redirectUrl: string;
  }> {
    const body = await this.#call<unknown>("POST", `${this.#linkBase}/connected_accounts/link`, {
      auth_config_id: input.authConfigId,
      user_id: input.userId,
      alias: input.alias,
      callback_url: input.callbackUrl,
      connection_data: { state_prefix: input.state },
    });
    const r = rec(body) ?? {};
    const redirectUrl = str(r.redirect_url) ?? str(r.redirectUrl);
    if (!redirectUrl?.startsWith("https://")) {
      throw new ComposioError("composio_link_failed", "Composio did not return an https redirect URL.");
    }
    return { connectedAccountId: str(r.connected_account_id) ?? str(r.id) ?? null, redirectUrl };
  }

  async getConnectedAccount(id: string): Promise<ComposioConnectedAccount> {
    const account = parseConnectedAccount(await this.#call("GET", `${this.#base}/connected_accounts/${encodeURIComponent(id)}`));
    if (!account) throw new ComposioError("composio_account_not_found", "Composio connected account was not found.", 404);
    return account;
  }

  async deleteConnectedAccount(id: string): Promise<void> {
    await this.#call("DELETE", `${this.#base}/connected_accounts/${encodeURIComponent(id)}`);
  }

  async executeTool(input: { slug: string; userId: string; connectedAccountId: string; arguments: Record<string, unknown> }): Promise<{
    successful: boolean;
    data: unknown;
    error: string | null;
  }> {
    const body = await this.#call<unknown>(
      "POST",
      `${this.#linkBase}/tools/execute/${encodeURIComponent(input.slug)}`,
      { user_id: input.userId, connected_account_id: input.connectedAccountId, version: "latest", arguments: input.arguments },
      60_000,
    );
    const r = rec(body) ?? {};
    return {
      successful: r.successful !== false && !str(r.error),
      data: r.data ?? null,
      error: str(r.error) ?? null,
    };
  }
}
