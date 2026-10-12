/**
 * Shared HTTP and loop helpers for the Telegram and Discord providers (harvest F1: v1 providers/common.ts httpRequest,
 * providers/rate.ts requestWithRetry/retryAfterSeconds). Every request goes through `net.fetch`; no redirects, one
 * timeout covering the body, a body size cap, and ONE retry on HTTP 429 when the provider names a wait of at most 30 s.
 * Errors never carry the URL or the transport error text (a Telegram URL contains the bot token).
 */
import { type ChannelCredentials, ChannelError, type ChannelNet, cleanInboundText, scrub } from "../provider.ts";

export interface ProviderResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
  headers: Headers;
}

export interface ProviderRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A longer named wait is not slept: the 429 is returned to the caller (v1 rate.ts MAX_RETRY_AFTER_SECONDS). */
export const MAX_RETRY_AFTER_SECONDS = 30;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Untrusted provider text for names: control/bidi characters removed, whitespace collapsed, capped. */
export function cleanName(value: unknown, max = 80): string {
  if (typeof value !== "string") return "";
  return Array.from(cleanInboundText(value).replace(/\s+/gu, " ").trim()).slice(0, max).join("");
}

/** retry_after in seconds: Telegram `parameters.retry_after`, Discord body `retry_after`, else the `Retry-After` header. */
export function retryAfterSeconds(response: ProviderResponse): number | undefined {
  const ok = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const record = asRecord(response.json);
  const fromBody = ok(asRecord(record?.parameters)?.retry_after) ?? ok(record?.retry_after);
  if (fromBody !== undefined) return fromBody;
  const header = response.headers.get("retry-after")?.trim();
  return header && /^\d+(\.\d+)?$/u.test(header) ? Number(header) : undefined;
}

/** Sleep that never throws (a production sleep may reject on abort); callers check `signal.aborted` after it. */
export async function pause(net: ChannelNet, ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await net.sleep(Math.max(0, Math.round(ms)), signal);
  } catch {
    // aborted
  }
}

/** Capped exponential backoff with jitter, never below 1 s (v1 discord-gateway scheduleReconnect). */
export function backoffMs(attempt: number, maxMs = 60_000, random: () => number = Math.random): number {
  return Math.max(1000, Math.min(maxMs, 1000 * 2 ** Math.min(attempt, 16)) * (0.5 + random() * 0.5));
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ChannelError("channel_provider_bad_response", "The provider answer was larger than expected.", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function once(net: ChannelNet, req: ProviderRequest, service: string): Promise<ProviderResponse> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await net.fetch(req.url, {
      method: req.method,
      redirect: "error",
      signal,
      headers: { accept: "application/json", ...(req.body === undefined ? {} : { "content-type": "application/json" }), ...req.headers },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    text = await readCapped(response);
  } catch (error) {
    if (req.signal?.aborted) throw error;
    if (error instanceof ChannelError) throw error;
    // Never the transport error text: it can contain the request URL (and so a Telegram token).
    const timedOut = timeout.aborted;
    throw new ChannelError(
      "channel_provider_unavailable",
      timedOut ? `${service} did not answer in time.` : `${service} could not be reached. Try again later.`,
      502,
    );
  }
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, headers: response.headers };
}

/**
 * One request with at most one retry on HTTP 429 (a 429 means the provider refused, so the retry cannot duplicate).
 * A second 429 or a wait longer than 30 s is returned as is; the caller maps it to `channel_rate_limited`.
 */
export async function providerRequest(net: ChannelNet, req: ProviderRequest, service: string): Promise<ProviderResponse> {
  const first = await once(net, req, service);
  if (first.status !== 429) return first;
  const seconds = retryAfterSeconds(first);
  if (seconds === undefined || seconds > MAX_RETRY_AFTER_SECONDS) return first;
  await pause(net, Math.ceil(seconds * 1000), req.signal);
  if (req.signal?.aborted) return first;
  return once(net, req, service);
}

export function rateLimited(service: string, response: ProviderResponse): ChannelError {
  const seconds = retryAfterSeconds(response);
  const wait = seconds === undefined ? "" : ` Try again in ${Math.ceil(seconds)} s.`;
  return new ChannelError("channel_rate_limited", `${service} is rate limiting this bot.${wait}`, 429);
}

/** Provider error text for a message: credential values removed, cleaned, capped. */
export function providerDetail(value: unknown, creds: ChannelCredentials): string {
  return cleanName(scrub(typeof value === "string" ? value : "", creds), 200);
}
