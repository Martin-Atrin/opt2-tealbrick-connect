/**
 * The ONLY file of the Connect UI that talks to the network.
 *
 * It mirrors the client declarations of `@opt2-tealbrick/miniapp-sdk/client` (SDK-API §14, `sdk.d.ts`):
 * `callOp<O>(op, input): Promise<O>`, `tbFetch(path, init?)`, `useSession()`, errors thrown as `TbError`
 * (an Error with `code`). When that package is released, replace this file with
 * `export { callOp, tbFetch, useSession, TbError } from "@opt2-tealbrick/miniapp-sdk/client";`
 * and nothing else in `src/ui/` changes.
 */
import { useCallback, useEffect, useState } from "react";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Same shape as the SDK `TbError`: `code` is the CORE error envelope code. */
export class TbError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 0) {
    super(message);
    this.name = "TbError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const CSRF_HEADER = "TB-CSRF";

/** Person ops of `crud: ["create"]` need an idempotency key (manifest `idempotency: "required"`, SDK-API §4.4). */
export const CREATE_OPS: ReadonlySet<string> = new Set(["account_connect", "catalog_account_connect", "buzz_identities_generate", "buzz_profile_publish"]);

/** App base path `/a/<product>/` (Vite `base`); the fallback is the deployed Connect path. */
const base = ((import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/a/connect/").replace(/\/*$/u, "/");

const newKey = (): string => globalThis.crypto.randomUUID();

/**
 * The ONE place that decides the body of a person op. Today: the input itself, and for create ops
 * `{ input, idempotencyKey }`. Change here when the SDK client fixes the wire shape.
 */
export function buildOpBody(op: string, input: Json): Json {
  return CREATE_OPS.has(op) ? { input, idempotencyKey: newKey() } : input;
}

let csrf: Promise<string> | null = null;

async function errorFrom(res: Response): Promise<TbError> {
  let code = `http_${res.status}`;
  let message = res.statusText || "The request failed.";
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (body.error && typeof body.error.code === "string") code = body.error.code;
    if (body.error && typeof body.error.message === "string") message = body.error.message;
  } catch {
    // not an error envelope: keep the status based code
  }
  return new TbError(code, message, res.status);
}

const url = (path: string): string => `${base}${path.replace(/^\/+/u, "")}`;

async function networkFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url(path), { credentials: "same-origin", ...init });
  } catch {
    throw new TbError("network_error", "Could not reach Teal Brick. Check your connection and try again.");
  }
}

/** `GET /a/<product>/tb/v1/session` → `SessionInfo { principal, csrf }`. */
export async function getSession(): Promise<{ principal: Record<string, Json>; csrf: string }> {
  const res = await networkFetch("tb/v1/session", { method: "GET", headers: { accept: "application/json" } });
  if (!res.ok) throw await errorFrom(res);
  const body = (await res.json()) as { principal?: Record<string, Json>; csrf?: string };
  if (!body.principal || typeof body.csrf !== "string") throw new TbError("session_invalid", "The session answer is not valid.", res.status);
  return { principal: body.principal, csrf: body.csrf };
}

function csrfToken(refresh: boolean): Promise<string> {
  if (!csrf || refresh) {
    const next = getSession().then((s) => s.csrf);
    next.catch(() => {
      if (csrf === next) csrf = null;
    });
    csrf = next;
  }
  return csrf;
}

/** Forget the cached session (tests, sign out). */
export function resetSession(): void {
  csrf = null;
}

/** Same-origin fetch under `/a/<product>/` with `TB-CSRF` on non-GET; a non-2xx answer throws `TbError`. */
export async function tbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(init.headers);
    if (mutating) headers.set(CSRF_HEADER, await csrfToken(attempt > 0));
    const res = await networkFetch(path, { ...init, method, headers });
    if (res.ok) return res;
    const error = await errorFrom(res);
    // The CSRF token is per session: fetch a fresh one once, then give up.
    if (mutating && attempt === 0 && error.code === "csrf_invalid") continue;
    throw error;
  }
}

/** Person op via `POST /a/<product>/tb/v1/ops/:op`. The answer is the op output. */
export async function callOp<O = Json>(op: string, input: Json): Promise<O> {
  const res = await tbFetch(`tb/v1/ops/${encodeURIComponent(op)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildOpBody(op, input)),
  });
  return (await res.json()) as O;
}

export interface UseSession {
  principal: Record<string, Json> | null;
  status: "loading" | "signed_in" | "signed_out";
  signOut(): Promise<void>;
}

export function useSession(): UseSession {
  const [state, setState] = useState<{ principal: Record<string, Json> | null; status: UseSession["status"] }>({ principal: null, status: "loading" });
  useEffect(() => {
    let live = true;
    getSession().then(
      (s) => live && setState({ principal: s.principal, status: "signed_in" }),
      () => live && setState({ principal: null, status: "signed_out" }),
    );
    return () => {
      live = false;
    };
  }, []);
  const signOut = useCallback(async () => {
    await tbFetch("tb/v1/logout", { method: "POST" });
    resetSession();
    setState({ principal: null, status: "signed_out" });
  }, []);
  return { ...state, signOut };
}
