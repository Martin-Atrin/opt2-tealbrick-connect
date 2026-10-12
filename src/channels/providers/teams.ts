/**
 * Microsoft Teams channel provider (C58; harvest HARVEST-CHANNELS F4, ported from v1 providers/teams.ts and
 * teams-auth.ts). Bot Framework REST (the transport under the Teams SDK) for a single-tenant Azure Bot.
 *
 * Credentials: `app_id` (Microsoft App ID, a GUID), `client_secret` (a client secret of that app registration) and
 * `tenant_id` (the Entra tenant the bot is registered in, a GUID).
 *
 * CONVERSATION REFERENCES. Bot Framework addresses every conversation through a per-region `serviceUrl` that only
 * inbound activities reveal, and the provider interface carries no extra field for it. So every Teams conversation
 * id this provider returns or accepts is the pair
 *
 *     `<serviceUrl>|<conversationId>`        e.g. `https://smba.trafficmanager.net/amer|19:abc@thread.tacv2`
 *
 * (`teamsConversationRef` / `parseTeamsConversationRef`). Inbound messages carry it in `conversation`;
 * `openDirect` returns it; `send` / `edit` / `delete` take it. The service URL must be on the allowlist
 * (`smba.trafficmanager.net`, `smba.infra.gcc.teams.microsoft.com`; https, no port), so a stored or agent-supplied
 * reference can never send the bot's access token elsewhere. Person ids use the same encoding,
 * `<serviceUrl>|<userId>` (`29:…` Teams user id or Entra object id): `InboundMessage.senderId` is already in that
 * shape, so the service passes it unchanged to `openDirect`.
 *
 * Inbound is a webhook (`verifyWebhook`): the Bot Connector posts activities with an RS256 JWT that is checked
 * against the Bot Framework OpenID keys. Every verification failure is the same 401 (no oracle).
 */
import { createHash, createPublicKey, type JsonWebKey, type KeyObject, verify as verifySignature } from "node:crypto";

import {
  type BotIdentity,
  type ChannelCredentials,
  ChannelError,
  type ChannelNet,
  type ChannelProvider,
  cleanInboundText,
  type InboundMessage,
  mentionList,
  scrub,
} from "../provider.ts";

export const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
export const BOT_FRAMEWORK_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const JWKS_HOST = "login.botframework.com";
const LOGIN_BASE = "https://login.microsoftonline.com";

/** Teams caps one bot message at about 100 KB; text above this is refused (never cut). */
export const TEAMS_MAX_TEXT_CHARS = 28_000;
const TEAMS_MAX_ACTIVITY_BYTES = 100_000;
/** A cached access token is renewed this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Clock skew for the inbound token validity window (Bot Framework docs). */
export const JWT_CLOCK_SKEW_SECONDS = 300;
/** The Bot Framework keys are refreshed at least once per day. */
export const JWKS_MAX_AGE_MS = 24 * 3_600_000;
/** An unknown `kid` refreshes the keys at most once per `kid` in this window (and a failed fetch blocks this long). */
export const JWKS_MIN_REFRESH_MS = 5 * 60_000;
/** Most unknown-`kid` refreshes in one window, whatever the `kid`s are. */
export const JWKS_MAX_REFRESHES_PER_WINDOW = 6;
/** Keys older than this are refreshed on an unknown `kid` even when the per-`kid` and window limits are spent. */
export const JWKS_FORCE_REFRESH_AGE_MS = 15 * 60_000;
/** Two fetch attempts are never closer than this (an outage never becomes one fetch per request). */
export const JWKS_MIN_ATTEMPT_SPACING_MS = 30_000;
const JWKS_MISSED_KIDS_MAX = 128;
/** One honoured Retry-After at most this long. */
const MAX_RETRY_AFTER_MS = 30_000;
const TIMEOUT_MS = 15_000;
const WEBHOOK_MAX_BODY_CHARS = 128 * 1024;
const MAX_RESPONSE_CHARS = 1024 * 1024;

/**
 * Bot Connector hosts accepted in a `serviceUrl` (public cloud and GCC; both use the public Bot Framework token
 * issuer). GCC High, DoD and 21Vianet use other auth clouds and are not supported.
 */
export const TEAMS_SERVICE_HOSTS: readonly string[] = ["smba.trafficmanager.net", "smba.infra.gcc.teams.microsoft.com"];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/u;
// `19:…@thread.tacv2`, `19:…@thread.v2`, `a:…` (personal). `;messageid=` is split off before this check.
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9:@._=+-]{2,255}$/u;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9:@._=-]{0,199}$/u;
const USER_ID = /^29:[A-Za-z0-9._-]{1,250}$/u;
const SENDER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,250}$/u;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
const AT_TAG = /<at\b[^>]*>([\s\S]*?)<\/at\s*>/giu;

// ---------------------------------------------------------------- References

/** True for an https Bot Connector service URL on the allowlist (no credentials, port, query or fragment). */
export function isAllowedServiceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("|") &&
    TEAMS_SERVICE_HOSTS.includes(url.hostname.toLowerCase()) &&
    /^\/[A-Za-z0-9._~/-]*$/u.test(url.pathname)
  );
}

function serviceBase(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

/** `https://smba.trafficmanager.net/amer/` + `19:abc@thread.tacv2` → `https://smba.trafficmanager.net/amer|19:abc@thread.tacv2`. */
export function teamsConversationRef(serviceUrl: string, id: string): string {
  if (!isAllowedServiceUrl(serviceUrl)) throw new ChannelError("channel_input_invalid", "The Teams service URL is not an allowed Bot Connector host.");
  if (typeof id !== "string" || id.length === 0 || id.includes("|")) throw new ChannelError("channel_input_invalid", "The Teams id is invalid.");
  return `${serviceBase(serviceUrl)}|${id}`;
}

/** Splits and validates a `<serviceUrl>|<id>` reference. Throws `channel_input_invalid` for anything else. */
export function parseTeamsConversationRef(ref: string): { serviceUrl: string; id: string } {
  const at = typeof ref === "string" ? ref.indexOf("|") : -1;
  if (at <= 0) {
    throw new ChannelError("channel_input_invalid", "A Teams conversation is `<serviceUrl>|<conversationId>`, as returned by inbound messages or openDirect.");
  }
  const serviceUrl = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (!isAllowedServiceUrl(serviceUrl)) throw new ChannelError("channel_input_invalid", "The Teams service URL is not an allowed Bot Connector host.");
  if (id.length === 0 || id.includes("|")) throw new ChannelError("channel_input_invalid", "The Teams id in the reference is invalid.");
  return { serviceUrl: serviceBase(serviceUrl), id };
}

function conversationOf(ref: string): { serviceUrl: string; id: string } {
  const parsed = parseTeamsConversationRef(ref);
  if (!CONVERSATION_ID.test(parsed.id)) throw new ChannelError("channel_input_invalid", "The Teams conversation id is invalid.");
  return parsed;
}

function activityId(value: unknown, what = "message id"): string {
  if (typeof value !== "string" || !MESSAGE_ID.test(value)) throw new ChannelError("channel_input_invalid", `The Teams ${what} is invalid.`);
  return value;
}

// ---------------------------------------------------------------- Credentials and tokens

type TeamsCreds = { appId: string; secret: string; tenantId: string };

function teamsCreds(creds: ChannelCredentials): TeamsCreds {
  const appId = creds.app_id?.trim() ?? "";
  const secret = creds.client_secret?.trim() ?? "";
  const tenantId = creds.tenant_id?.trim() ?? "";
  if (!appId || !secret || !tenantId) throw new ChannelError("channel_credentials_missing", "Enter the Teams app id, client secret and tenant id.");
  if (!GUID.test(appId)) throw new ChannelError("channel_credentials_invalid", "The Teams app id must be a GUID (Microsoft App ID of the Azure Bot).");
  if (!GUID.test(tenantId)) throw new ChannelError("channel_credentials_invalid", "The Teams tenant id must be a GUID.");
  if (!SECRET_SHAPE.test(secret)) throw new ChannelError("channel_credentials_invalid", "The Teams client secret has an invalid shape.");
  return { appId: appId.toLowerCase(), secret, tenantId: tenantId.toLowerCase() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return undefined;
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

async function request(net: ChannelNet, url: string, init: RequestInit, creds: ChannelCredentials): Promise<Response> {
  try {
    return await net.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const detail = error instanceof Error ? scrub(error.message, creds).slice(0, 120) : "network error";
    throw new ChannelError("channel_provider_unavailable", `Microsoft did not answer (${detail}).`, 502);
  }
}

// Module-level: one cache per (tenant, app, secret digest) across accounts and calls. Never holds a second copy
// of the secret (only its digest is in the key).
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const tokenInflight = new Map<string, Promise<string>>();

function tokenKey(c: TeamsCreds): string {
  const digest = createHash("sha256").update(c.secret).digest("hex").slice(0, 16);
  return `${c.tenantId}:${c.appId}:${digest}`;
}

async function fetchToken(c: TeamsCreds, net: ChannelNet, creds: ChannelCredentials, key: string): Promise<string> {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.appId, client_secret: c.secret, scope: BOT_FRAMEWORK_SCOPE });
  const response = await request(
    net,
    `${LOGIN_BASE}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
    creds,
  );
  const json = await readJson(response);
  if (response.status === 400 || response.status === 401) {
    const error = typeof json?.error === "string" ? json.error : "";
    if (response.status === 401 || ["invalid_client", "unauthorized_client", "invalid_request", "invalid_grant", "invalid_scope"].includes(error)) {
      throw new ChannelError("channel_credentials_rejected", "Microsoft Entra rejected the Teams app id, client secret or tenant id.", 401);
    }
  }
  const token = json?.access_token;
  if (!response.ok || typeof token !== "string" || !/^[\x21-\x7e]{16,8192}$/u.test(token)) {
    throw new ChannelError("channel_provider_unavailable", `Microsoft Entra did not issue a token (HTTP ${response.status}).`, 502);
  }
  const seconds = Number(json?.expires_in);
  const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
  tokenCache.set(key, { token, expiresAt: net.now() + lifetimeMs - TOKEN_REFRESH_MARGIN_MS });
  return token;
}

/** Client-credentials token for the Bot Connector, cached until expiry − 5 min, concurrent requests share one fetch. */
async function accessToken(c: TeamsCreds, net: ChannelNet, creds: ChannelCredentials): Promise<string> {
  const key = tokenKey(c);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > net.now()) return cached.token;
  tokenCache.delete(key);
  const running = tokenInflight.get(key);
  if (running) return running;
  const next = fetchToken(c, net, creds, key).finally(() => tokenInflight.delete(key));
  tokenInflight.set(key, next);
  return next;
}

/** Drops every cached access token and signing key (secret rotation; tests). */
export function resetTeamsCaches(): void {
  tokenCache.clear();
  tokenInflight.clear();
  jwks.reset();
}

/**
 * One Bot Connector call: a 401 renews the token once; a 429 honours Retry-After once (≤ 30 s); a 412 runs once
 * more; nothing else is retried (a send is never blindly repeated after a 5xx).
 */
async function connector(
  c: TeamsCreds,
  net: ChannelNet,
  creds: ChannelCredentials,
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Record<string, unknown> | undefined> {
  let renewed = false;
  let retried = false;
  for (;;) {
    const token = await accessToken(c, net, creds);
    const response = await request(
      net,
      url,
      {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      creds,
    );
    if (response.status === 401 && !renewed) {
      renewed = true;
      tokenCache.delete(tokenKey(c));
      continue;
    }
    if (!retried && (response.status === 429 || response.status === 412)) {
      const seconds = Number(response.headers.get("retry-after"));
      const wait = response.status === 429 && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1_000;
      if (wait <= MAX_RETRY_AFTER_MS) {
        retried = true;
        await net.sleep(wait);
        continue;
      }
    }
    if (response.ok) return await readJson(response);
    throw connectorError(response.status);
  }
}

function connectorError(status: number): ChannelError {
  if (status === 401) return new ChannelError("channel_credentials_rejected", "The Bot Connector rejected the Teams app token.", 401);
  if (status === 403) {
    return new ChannelError(
      "channel_not_member",
      "The Teams app is not installed in this conversation (or for this person). Install the app in the team or chat, then try again.",
      403,
    );
  }
  if (status === 404) return new ChannelError("channel_not_found", "Teams could not find this conversation or message.", 404);
  if (status === 413) return new ChannelError("channel_text_too_long", "Teams refused the message as too large.");
  if (status === 429) return new ChannelError("channel_rate_limited", "Teams rate limit reached. Try again later.", 429);
  if (status >= 500) return new ChannelError("channel_provider_unavailable", `The Bot Connector answered HTTP ${status}.`, 502);
  return new ChannelError("channel_provider_error", `The Bot Connector refused the request (HTTP ${status}).`, 502);
}

function outboundActivity(text: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof text !== "string" || text.trim().length === 0) throw new ChannelError("channel_text_empty", "A Teams message needs text.");
  if (text.length > TEAMS_MAX_TEXT_CHARS) {
    throw new ChannelError("channel_text_too_long", `The text is ${text.length} characters; Teams allows ${TEAMS_MAX_TEXT_CHARS}.`);
  }
  // An `<at>` tag without a declared mention entity could ping people; mentions are not supported here.
  if (/<at\b/iu.test(text)) throw new ChannelError("channel_input_invalid", "Teams <at> mention tags are not supported in agent text.");
  const activity = { type: "message", ...extra, text, textFormat: "markdown" };
  if (Buffer.byteLength(JSON.stringify(activity), "utf8") > TEAMS_MAX_ACTIVITY_BYTES) {
    throw new ChannelError("channel_text_too_long", `The Teams message is larger than ${TEAMS_MAX_ACTIVITY_BYTES} bytes.`);
  }
  return activity;
}

// ---------------------------------------------------------------- Inbound JWT

type SigningKey = { key: KeyObject; endorsements: string[] };

function base64UrlJson(part: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function toSigningKey(raw: unknown): [string, SigningKey] | undefined {
  const jwk = asRecord(raw);
  if (!jwk || typeof jwk.kid !== "string" || jwk.kid.length === 0 || jwk.kid.length > 200) return undefined;
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return undefined;
  const endorsements = Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((v): v is string => typeof v === "string") : [];
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
    return key.asymmetricKeyType === "rsa" ? [jwk.kid, { key, endorsements }] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bot Framework signing keys (v1 policy): the `jwks_uri` from the OpenID metadata must stay on
 * login.botframework.com; keys are kept 24 h; an unknown `kid` refreshes at most once per `kid` per 5 min and at most
 * 6 times per 5 min in all (forced when keys are older than 15 min), never two attempts within 30 s; stale keys stay
 * usable while a refresh fails. Module-level: the keys are global to Bot Framework.
 */
class JwksCache {
  #keys = new Map<string, SigningKey>();
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  #failedAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<boolean> | null = null;
  #missedKids = new Map<string, number>();
  #windowAttempts: number[] = [];

  reset(): void {
    this.#keys = new Map();
    this.#fetchedAt = Number.NEGATIVE_INFINITY;
    this.#attemptedAt = Number.NEGATIVE_INFINITY;
    this.#failedAt = Number.NEGATIVE_INFINITY;
    this.#refreshing = null;
    this.#missedKids = new Map();
    this.#windowAttempts = [];
  }

  async #refresh(net: ChannelNet): Promise<boolean> {
    this.#attemptedAt = net.now();
    const get = async (url: string) => {
      const response = await net.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      return response.ok ? await readJson(response) : undefined;
    };
    const metadata = await get(BOT_FRAMEWORK_OPENID_URL);
    let jwksUrl: URL;
    try {
      jwksUrl = new URL(typeof metadata?.jwks_uri === "string" ? metadata.jwks_uri : "");
    } catch {
      return false;
    }
    if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== JWKS_HOST || jwksUrl.port !== "" || jwksUrl.username !== "") return false;
    const list = (await get(jwksUrl.toString()))?.keys;
    if (!Array.isArray(list)) return false;
    const next = new Map<string, SigningKey>();
    for (const raw of list.slice(0, 100)) {
      const entry = toSigningKey(raw);
      if (entry) next.set(entry[0], entry[1]);
    }
    if (next.size === 0) return false;
    this.#keys = next;
    this.#fetchedAt = net.now();
    return true;
  }

  #refreshOnce(net: ChannelNet): Promise<boolean> {
    this.#refreshing ??= this.#refresh(net)
      .catch(() => false)
      .then((ok) => {
        if (!ok) this.#failedAt = net.now();
        return ok;
      })
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  #mayRefresh(kid: string, now: number): boolean {
    const age = now - this.#fetchedAt;
    const spaced = now - this.#attemptedAt >= JWKS_MIN_ATTEMPT_SPACING_MS;
    if (this.#keys.has(kid)) return age > JWKS_MAX_AGE_MS && spaced;
    const forced = age > JWKS_FORCE_REFRESH_AGE_MS && spaced;
    const lastMiss = this.#missedKids.get(kid);
    this.#windowAttempts = this.#windowAttempts.filter((at) => now - at < JWKS_MIN_REFRESH_MS);
    const limited =
      spaced &&
      now - this.#failedAt >= JWKS_MIN_REFRESH_MS &&
      (lastMiss === undefined || now - lastMiss >= JWKS_MIN_REFRESH_MS) &&
      this.#windowAttempts.length < JWKS_MAX_REFRESHES_PER_WINDOW;
    if (!forced && !limited) return false;
    if (!forced) this.#windowAttempts.push(now);
    this.#missedKids.delete(kid);
    this.#missedKids.set(kid, now);
    while (this.#missedKids.size > JWKS_MISSED_KIDS_MAX) {
      const oldest = this.#missedKids.keys().next().value;
      if (oldest === undefined) break;
      this.#missedKids.delete(oldest);
    }
    return true;
  }

  async keyFor(kid: string, net: ChannelNet): Promise<SigningKey | undefined> {
    if (this.#refreshing) await this.#refreshing;
    else if (this.#mayRefresh(kid, net.now())) await this.#refreshOnce(net);
    return this.#keys.get(kid);
  }
}

const jwks = new JwksCache();

const unauthorized = () => new ChannelError("channel_webhook_unauthorized", "unauthorized", 401);

/** The service URL claim: lowercase `serviceurl` (Bot Framework SDK), `serviceUrl` as a fallback. */
function serviceUrlClaim(claims: Record<string, unknown>): string | undefined {
  if (typeof claims.serviceurl === "string") return claims.serviceurl;
  return typeof claims.serviceUrl === "string" ? claims.serviceUrl : undefined;
}

/** Checks the Bearer JWT and returns the parsed activity, or throws the one generic 401. */
async function verifiedActivity(request: { headers: Headers; body: string }, c: TeamsCreds, net: ChannelNet): Promise<Record<string, unknown>> {
  const match = BEARER.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!match) throw unauthorized();
  const [, headerPart = "", payloadPart = "", signaturePart = ""] = match;
  const header = base64UrlJson(headerPart);
  const claims = base64UrlJson(payloadPart);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") throw unauthorized();
  if (claims.iss !== BOT_FRAMEWORK_ISSUER) throw unauthorized();
  const aud = claims.aud;
  if (!(aud === c.appId || (Array.isArray(aud) && aud.length === 1 && aud[0] === c.appId))) throw unauthorized();
  const nowSeconds = Math.floor(net.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + JWT_CLOCK_SKEW_SECONDS < nowSeconds) throw unauthorized();
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - JWT_CLOCK_SKEW_SECONDS > nowSeconds)) throw unauthorized();
  const claimedServiceUrl = serviceUrlClaim(claims);
  if (claimedServiceUrl === undefined) throw unauthorized();
  // The body is parsed only after the token's own claims passed.
  if (typeof request.body !== "string" || request.body.length > WEBHOOK_MAX_BODY_CHARS) throw unauthorized();
  let activity: Record<string, unknown> | undefined;
  try {
    activity = asRecord(JSON.parse(request.body));
  } catch {
    activity = undefined;
  }
  // Without a readable activity whose serviceUrl matches, a token never causes a key refresh.
  if (!activity || activity.serviceUrl !== claimedServiceUrl || !isAllowedServiceUrl(activity.serviceUrl)) throw unauthorized();
  const key = await jwks.keyFor(header.kid, net);
  if (!key) throw unauthorized();
  let valid = false;
  try {
    valid = verifySignature("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key.key, Buffer.from(signaturePart, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) throw unauthorized();
  // The key must be endorsed for the channel the activity claims to come from.
  if (activity.channelId !== "msteams" || !key.endorsements.includes("msteams")) throw unauthorized();
  const conversation = asRecord(activity.conversation);
  const tenant = String(conversation?.tenantId ?? asRecord(asRecord(activity.channelData)?.tenant)?.id ?? "").toLowerCase();
  if (tenant !== c.tenantId) throw unauthorized();
  const recipient = asRecord(activity.recipient);
  if (typeof recipient?.id !== "string" || recipient.id.toLowerCase() !== `28:${c.appId}`) throw unauthorized();
  return activity;
}

/** Text without the bot's own `<at>` mention; other `<at>Name</at>` tags become `Name`. Untrusted, cleaned. */
function inboundText(activity: Record<string, unknown>, botId: string): string {
  let text = typeof activity.text === "string" ? activity.text : "";
  const entities = Array.isArray(activity.entities) ? activity.entities : [];
  for (const raw of entities) {
    const entity = asRecord(raw);
    const mentioned = asRecord(entity?.mentioned);
    if (entity?.type === "mention" && typeof mentioned?.id === "string" && mentioned.id.toLowerCase() === botId && typeof entity.text === "string" && entity.text) {
      text = text.split(entity.text).join("");
    }
  }
  const botName = asRecord(activity.recipient)?.name;
  text = text.replace(AT_TAG, (_tag, inner: string) => (typeof botName === "string" && inner.trim() === botName ? "" : inner));
  return cleanInboundText(text.replace(/[ \t]{2,}/gu, " ").trim());
}

/** F15: ids of `mention` entities (Bot Framework ids; the bot is `28:<appId>`), lower-case like the bot id. */
function teamsMentions(activity: Record<string, unknown>): string[] {
  const entities = Array.isArray(activity.entities) ? activity.entities : [];
  return mentionList(
    entities
      .map((raw) => asRecord(raw))
      .filter((e) => e?.type === "mention")
      .map((e) => asRecord(e?.mentioned)?.id)
      .filter((id): id is string => typeof id === "string" && SENDER_ID.test(id))
      .map((id) => id.toLowerCase()),
  );
}

function parseMessage(activity: Record<string, unknown>, c: TeamsCreds, net: ChannelNet): InboundMessage | null {
  const botId = `28:${c.appId}`;
  const serviceUrl = activity.serviceUrl as string;
  const from = asRecord(activity.from);
  const senderId = from?.id;
  if (typeof senderId !== "string" || !SENDER_ID.test(senderId)) return null;
  // The bot itself and every other bot (role "bot" or a Bot Framework `28:` id) are ignored: no bot loops.
  if (senderId.toLowerCase() === botId || from?.role === "bot" || senderId.startsWith("28:")) return null;
  const messageId = activity.id;
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return null;
  const conversation = asRecord(activity.conversation);
  const rawId = typeof conversation?.id === "string" ? conversation.id : "";
  const [conversationId = "", threadSuffix] = rawId.split(";messageid=");
  if (!CONVERSATION_ID.test(conversationId)) return null;
  const kind = conversation?.conversationType;
  const conversationType = kind === "personal" ? "direct" : kind === "groupChat" ? "group" : kind === "channel" ? "channel" : null;
  if (!conversationType) return null;
  const threadId =
    threadSuffix && MESSAGE_ID.test(threadSuffix)
      ? threadSuffix
      : typeof activity.replyToId === "string" && MESSAGE_ID.test(activity.replyToId)
        ? activity.replyToId
        : null;
  const channelData = asRecord(activity.channelData);
  const name = cleanInboundText(String(conversation?.name ?? asRecord(channelData?.channel)?.name ?? ""), 80).trim();
  const senderName = cleanInboundText(typeof from?.name === "string" ? from.name : "", 80).trim() || senderId;
  const sent = typeof activity.timestamp === "string" ? Date.parse(activity.timestamp) : Number.NaN;
  return {
    conversation: teamsConversationRef(serviceUrl, conversationId),
    ...(name ? { conversationName: name } : {}),
    conversationType,
    messageId,
    threadId: threadId === messageId ? null : threadId,
    senderId: teamsConversationRef(serviceUrl, senderId),
    senderName,
    text: inboundText(activity, botId),
    sentAt: Number.isFinite(sent) ? sent : net.now(),
    mentions: teamsMentions(activity),
  };
}

// ---------------------------------------------------------------- Provider

async function withScrub<T>(creds: ChannelCredentials, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ChannelError) {
      const clean = scrub(error.message, creds);
      throw clean === error.message ? error : new ChannelError(error.code, clean, error.httpStatus);
    }
    throw new ChannelError("channel_provider_error", scrub(error instanceof Error ? error.message : String(error), creds).slice(0, 200), 502);
  }
}

const activitiesUrl = (serviceUrl: string, id: string) => `${serviceUrl}/v3/conversations/${encodeURIComponent(id)}/activities`;

export const teamsProvider: ChannelProvider = {
  service: "teams",
  credentialFields: ["app_id", "client_secret", "tenant_id"],
  maxTextLength: TEAMS_MAX_TEXT_CHARS,

  verify: (creds, net) =>
    withScrub(creds, async (): Promise<BotIdentity> => {
      const c = teamsCreds(creds);
      // A token proves app id + secret + tenant belong together; Teams has no "who am I" call for a bot.
      await accessToken(c, net, creds);
      return { botId: `28:${c.appId}`, botName: "Teams bot", workspace: c.tenantId };
    }),

  // Bot Framework has no "list my conversations" call; the service records conversations from inbound activities.
  conversations: async (creds) => {
    teamsCreds(creds);
    return [];
  },

  send: (creds, net, input) =>
    withScrub(creds, async () => {
      const c = teamsCreds(creds);
      const { serviceUrl, id } = conversationOf(input.conversation);
      const activity = outboundActivity(input.text);
      const replyTo = input.threadId == null ? null : activityId(input.threadId, "thread id");
      const url = `${activitiesUrl(serviceUrl, id)}${replyTo ? `/${encodeURIComponent(replyTo)}` : ""}`;
      const body = await connector(c, net, creds, url, "POST", activity);
      const messageId = body?.id;
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
        throw new ChannelError("channel_provider_unavailable", "Teams answered success without an activity id; delivery is unknown.", 502);
      }
      return { messageId };
    }),

  edit: (creds, net, input) =>
    withScrub(creds, async () => {
      const c = teamsCreds(creds);
      const { serviceUrl, id } = conversationOf(input.conversation);
      const messageId = activityId(input.messageId);
      const activity = outboundActivity(input.text, { id: messageId });
      await connector(c, net, creds, `${activitiesUrl(serviceUrl, id)}/${encodeURIComponent(messageId)}`, "PUT", activity);
    }),

  delete: (creds, net, input) =>
    withScrub(creds, async () => {
      const c = teamsCreds(creds);
      const { serviceUrl, id } = conversationOf(input.conversation);
      const messageId = activityId(input.messageId);
      await connector(c, net, creds, `${activitiesUrl(serviceUrl, id)}/${encodeURIComponent(messageId)}`, "DELETE");
    }),

  react: async () => {
    throw new ChannelError("channel_action_unsupported", "Teams bots cannot add reactions.");
  },

  openDirect: (creds, net, input) =>
    withScrub(creds, async () => {
      const c = teamsCreds(creds);
      const { serviceUrl, id: userId } = parseTeamsConversationRef(input.personId);
      if (!USER_ID.test(userId) && !GUID.test(userId)) {
        throw new ChannelError("channel_input_invalid", "The Teams person id must be `<serviceUrl>|<userId>` with a 29:… user id or an Entra object id.");
      }
      // createConversation returns the existing 1:1 conversation when there is one, so a repeat posts nothing.
      const body = await connector(c, net, creds, `${serviceUrl}/v3/conversations`, "POST", {
        bot: { id: `28:${c.appId}` },
        members: [{ id: userId }],
        tenantId: c.tenantId,
        isGroup: false,
        channelData: { tenant: { id: c.tenantId } },
      });
      const conversationId = body?.id;
      if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) {
        throw new ChannelError("channel_provider_unavailable", "Teams answered success without a conversation id.", 502);
      }
      return { conversation: teamsConversationRef(serviceUrl, conversationId) };
    }),

  inbound: {
    kind: "webhook",
    async verifyWebhook(request, creds, net) {
      let c: TeamsCreds;
      try {
        c = teamsCreds(creds);
      } catch {
        throw unauthorized();
      }
      let activity: Record<string, unknown>;
      try {
        activity = await verifiedActivity(request, c, net);
      } catch {
        throw unauthorized();
      }
      const reply = { status: 200, body: "" };
      if (activity.type !== "message") return { messages: [], reply }; // conversationUpdate, installationUpdate, …
      const message = parseMessage(activity, c, net);
      return { messages: message ? [message] : [], reply };
    },
  },
};
