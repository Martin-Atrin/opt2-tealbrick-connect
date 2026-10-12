/**
 * MCP OAuth client (harvest: v1 Portal Core mcp-oauth.ts, which moves into Connect per D11; HARVEST §C).
 * 1. Probe the server; read `WWW-Authenticate resource_metadata` (RFC 9728), else `/.well-known/oauth-protected-resource`.
 * 2. Protected resource metadata must name the probed resource; take the first authorization server.
 * 3. AS metadata: RFC 8414 (path-inserted and root forms), then OpenID discovery; issuer must match; S256 required.
 * 4. Dynamic client registration (RFC 7591) as a public client (`token_endpoint_auth_method: none`).
 * 5. PKCE S256 + one-time state (only its hash stored, 30 min), `resource` indicator (RFC 8707), minimal scopes
 *    (the `scope` from WWW-Authenticate, else none — v1 requested every supported scope).
 * 6. Code exchange and refresh (refresh token kept when the server sends none).
 * Every request: outbound policy, `redirect: "error"`, 10 s timeout. Tokens live only in ctx.secrets.
 */
import { createHash, randomBytes } from "node:crypto";

import type { FetchLike } from "../../util/http.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { safeFetch as pinnedSafeFetch } from "../../util/pinned-fetch.ts";

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

export interface OAuthNet {
  fetchImpl?: FetchLike;
  lookup?: Lookup;
  allowOrigins?: readonly string[];
}

export interface OAuthServer {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scope: string | null;
}

export interface OAuthClient {
  clientId: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const b64url = (b: Buffer) => b.toString("base64url");

async function safeFetch(net: OAuthNet, url: string, init: RequestInit = {}): Promise<Response> {
  await assertEndpointAllowed(url, { schemes: ["https:"], ...(net.lookup ? { lookup: net.lookup } : {}), ...(net.allowOrigins ? { allowOrigins: net.allowOrigins } : {}) });
  try {
    return await (net.fetchImpl ?? pinnedSafeFetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new OAuthError("oauth_unreachable", `OAuth request failed (${error instanceof Error ? error.name : "error"}).`);
  }
}

async function json(net: OAuthNet, url: string, init?: RequestInit): Promise<Rec | undefined> {
  const response = await safeFetch(net, url, { ...init, headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) } });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const text = await response.text();
  if (text.length > 256 * 1024) throw new OAuthError("oauth_response_too_large", "OAuth metadata is too large.");
  try {
    return rec(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function authParam(header: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]+)"`, "iu").exec(header)?.[1];
}

function wellKnownCandidates(issuer: URL, suffix: string): string[] {
  const path = issuer.pathname.replace(/\/+$/u, "");
  return path ? [`${issuer.origin}/.well-known/${suffix}${path}`, `${issuer.origin}${path}/.well-known/${suffix}`] : [`${issuer.origin}/.well-known/${suffix}`];
}

/** Steps 1–3. Returns null when the server needs no OAuth (the probe is not a 401). */
export async function discover(net: OAuthNet, resourceUrl: string): Promise<OAuthServer | null> {
  const resource = new URL(resourceUrl);
  const probe = await safeFetch(net, resource.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tealbrick-connect", version: "0" } } }),
  });
  await probe.body?.cancel();
  if (probe.status !== 401) return null;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const metadataUrl = authParam(challenge, "resource_metadata") ?? wellKnownCandidates(resource, "oauth-protected-resource")[0];
  if (!metadataUrl) throw new OAuthError("oauth_metadata_missing", "The MCP server did not publish OAuth metadata.");
  const prm = await json(net, new URL(metadataUrl, resource).toString());
  const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
  const claimed = str(prm?.resource);
  if (!prm || !claimed || new URL(claimed).toString().replace(/\/+$/u, "") !== resource.toString().replace(/\/+$/u, "") || !str(servers[0])) {
    throw new OAuthError("oauth_invalid_resource_metadata", "The protected resource metadata does not match this server.");
  }
  const issuer = new URL(String(servers[0]));
  let meta: Rec | undefined;
  for (const candidate of [...wellKnownCandidates(issuer, "oauth-authorization-server"), ...wellKnownCandidates(issuer, "openid-configuration")]) {
    meta = await json(net, candidate);
    if (meta) break;
  }
  if (!meta) throw new OAuthError("oauth_metadata_missing", "The authorization server publishes no metadata.");
  const claimedIssuer = str(meta.issuer)?.replace(/\/+$/u, "");
  if (claimedIssuer !== issuer.toString().replace(/\/+$/u, "")) throw new OAuthError("oauth_issuer_mismatch", "The authorization server issuer does not match.");
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : [];
  if (!methods.includes("S256")) throw new OAuthError("oauth_pkce_unsupported", "The authorization server does not support PKCE S256.");
  const authorizationEndpoint = str(meta.authorization_endpoint);
  const tokenEndpoint = str(meta.token_endpoint);
  const registrationEndpoint = str(meta.registration_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) throw new OAuthError("oauth_metadata_invalid", "The authorization server metadata is incomplete.");
  if (!registrationEndpoint) throw new OAuthError("oauth_registration_unsupported", "The server does not allow client registration; connect it with an API key header instead.");
  // Every OAuth endpoint must be https (an exact allowlisted origin excepted), checked here on the server (SEC-09).
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, registrationEndpoint]) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new OAuthError("oauth_metadata_invalid", "An OAuth endpoint is not a valid URL.");
    }
    if (u.protocol !== "https:" && !(net.allowOrigins ?? []).includes(u.origin)) throw new OAuthError("oauth_endpoint_insecure", "OAuth endpoints must use https.");
    if (u.username || u.password) throw new OAuthError("oauth_metadata_invalid", "OAuth endpoints must not carry credentials.");
  }
  return { resource: resource.toString(), issuer: claimedIssuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint, scope: authParam(challenge, "scope") ?? null };
}

/** Step 4: register Connect as a public client for this redirect URI. */
export async function register(net: OAuthNet, server: OAuthServer, redirectUri: string, clientName: string): Promise<OAuthClient> {
  const body = await json(net, server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const clientId = str(body?.client_id);
  const method = str(body?.token_endpoint_auth_method);
  if (!clientId || (method && method !== "none")) throw new OAuthError("oauth_registration_failed", "Client registration failed.");
  return { clientId };
}

/** Step 5: authorization URL + the secrets the callback needs (state and verifier are never logged). */
export function authorization(server: OAuthServer, client: OAuthClient, redirectUri: string): { url: string; state: string; verifier: string } {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", server.resource);
  if (server.scope) url.searchParams.set("scope", server.scope);
  return { url: url.toString(), state, verifier };
}

async function tokenRequest(net: OAuthNet, server: OAuthServer, params: Record<string, string>, previousRefresh: string | null): Promise<OAuthTokens> {
  const body = await json(net, server.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, resource: server.resource }).toString(),
  });
  const accessToken = str(body?.access_token);
  if (!accessToken || (str(body?.token_type) ?? "bearer").toLowerCase() !== "bearer") throw new OAuthError("oauth_token_failed", "The token request failed.");
  const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return { accessToken, refreshToken: str(body?.refresh_token) ?? previousRefresh, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null };
}

export function exchangeCode(net: OAuthNet, server: OAuthServer, client: OAuthClient, input: { code: string; verifier: string; redirectUri: string }): Promise<OAuthTokens> {
  return tokenRequest(net, server, { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, client_id: client.clientId, redirect_uri: input.redirectUri }, null);
}

export function refresh(net: OAuthNet, server: OAuthServer, client: OAuthClient, refreshToken: string): Promise<OAuthTokens> {
  return tokenRequest(net, server, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId }, refreshToken);
}
