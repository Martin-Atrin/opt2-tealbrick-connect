/**
 * One outbound JSON client for third-party APIs: timeout, response size cap, no redirects, retry with backoff on
 * 429/5xx for idempotent requests, typed errors. Upstream bodies in errors are redacted and truncated.
 */
import { redactDeep } from "./redact.ts";

export type FetchLike = typeof fetch;

export class UpstreamError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
  }
}

export interface JsonRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  /** Retries on 429/502/503/504 and network errors. Default: 2 for GET, 0 otherwise. */
  retries?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpstreamError("upstream_response_too_large", `Upstream response exceeds ${maxBytes} bytes.`, response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  return null;
}

export async function requestJson<T = unknown>(req: JsonRequest): Promise<T> {
  const method = req.method ?? "GET";
  const retries = req.retries ?? (method === "GET" ? 2 : 0);
  const fetchImpl = req.fetchImpl ?? (await import("./pinned-fetch.ts")).safeFetch;
  const sleep = req.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(req.url, {
        method,
        headers: {
          accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
          ...req.headers,
        },
        body: req.body === undefined ? null : JSON.stringify(req.body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (attempt < retries && !req.signal?.aborted) {
        attempt += 1;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      const timedOut = timeout.aborted;
      throw new UpstreamError(
        timedOut ? "upstream_timeout" : "upstream_unreachable",
        timedOut ? "Upstream request timed out." : `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (RETRY_STATUS.has(response.status) && attempt < retries) {
      attempt += 1;
      await response.body?.cancel();
      await sleep(retryAfterMs(response) ?? 250 * 2 ** attempt);
      continue;
    }
    const text = await readCapped(response, req.maxBytes ?? DEFAULT_MAX_BYTES);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text: text.slice(0, 1000) };
      }
    }
    if (!response.ok) {
      const detail = JSON.stringify(redactDeep(payload)).slice(0, 1000);
      throw new UpstreamError(
        response.status === 401 || response.status === 403 ? "upstream_unauthorized" : response.status === 404 ? "upstream_not_found" : "upstream_error",
        `Upstream answered ${response.status}: ${detail}`,
        response.status,
      );
    }
    return payload as T;
  }
}
