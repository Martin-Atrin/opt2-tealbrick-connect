import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppSecrets, SdkOpContext, SdkPublicContext } from "@opt2-tealbrick/miniapp-sdk";
import type { CrudAction } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json } from "@opt2-tealbrick/spec/sdk";

import { ACCESS_CRUD, type AccessLevel } from "../src/effect.ts";

export const root = join(import.meta.dirname, "..");

/** node:sqlite with the app baseline applied, shaped like the SDK `Db` handle. */
export function testDb(): Db {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0002_drop_unused_tables.sql", "0003_buzz_contacts.sql", "0004_channels.sql"]) db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => stmt.run(...(params as never[])) as { changes: number; lastInsertRowid: number | bigint },
        get: (...params) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
        all: (...params) => stmt.all(...(params as never[])) as Record<string, unknown>[],
      };
    },
    transaction: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** In-memory stand-in for the SDK `ctx.secrets` (the SDK seals under TB_KEK; tests only need the contract). */
export function memorySecrets(): AppSecrets & { names(): string[] } {
  const map = new Map<string, string>();
  return {
    put: async (name, value) => void map.set(name, value),
    get: async (name) => map.get(name) ?? null,
    delete: async (name) => void map.delete(name),
    names: () => [...map.keys()].sort(),
  };
}
const secretsByDb = new WeakMap<Db, ReturnType<typeof memorySecrets>>();
export function secretsFor(db: Db) {
  let secrets = secretsByDb.get(db);
  if (!secrets) {
    secrets = memorySecrets();
    secretsByDb.set(db, secrets);
  }
  return secrets;
}
export const scopeCreates: { type: string; id: string; label: string }[] = [];
const scopesStub = {
  instances: {
    create: async (type: string, id: string, label: string) => {
      scopeCreates.push({ type, id, label });
      return { type, id, label, shared: false };
    },
    list: async () => [],
  },
};

/** Public-route context as the SDK passes it (C31 extras). */
export function publicCtx(db: Db, input: { workspace?: string | null; keys?: Record<string, string> } = {}): SdkPublicContext {
  return {
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    getKey: async (name) => input.keys?.[name] ?? null,
    publicUrl: "https://bridge.example.com",
    workspace: (input.workspace === undefined ? "ws_TEST" : input.workspace) as never,
    scopes: scopesStub,
    secrets: secretsFor(db),
  };
}

/** Minimal OpContext for handler tests: scope access from a map (agent → account → level). */
export function testCtx(input: {
  db: Db;
  agent?: string;
  access?: Record<string, AccessLevel>;
  keys?: Record<string, string>;
  ws?: string;
  /** person call from the app UI: no grant */
  person?: boolean;
  /** SDK workspace (slice / person principal); defaults to `ws` */
  workspace?: string | null;
  publicUrl?: string | null;
}): SdkOpContext & { receipts: { summary: string[]; meta: Json[] } } {
  const access = input.access ?? {};
  const receipts = { summary: [] as string[], meta: [] as Json[] };
  const agent = input.agent ?? "agt_01TESTAGENT0000000000000000";
  const can = async (_type: string, id: string, crud: CrudAction) => {
    const level = access[id];
    return level ? ACCESS_CRUD[level].includes(crud) : false;
  };
  return {
    caller: input.person
      ? { type: "person", id: "per_01TESTOWNER00000000000000" as `per_${string}`, name: "Owner", mode: null }
      : { type: "agent", id: agent as `agt_${string}`, name: "Test agent", mode: "free" },
    grant: input.person ? null : { ok: true, token: "t", claims: { ws: input.ws ?? "ws_TEST" } as never, caller: { type: "agent", id: agent as `agt_${string}` } },
    op: {} as never,
    scope: {
      access: null,
      readable: async () => Object.keys(access),
      writable: async () => Object.entries(access).filter(([, l]) => l !== "read").map(([id]) => id),
      can,
    },
    callId: null,
    idempotencyKey: null,
    context: {},
    receipt: { summary: (t) => receipts.summary.push(t), meta: (m) => receipts.meta.push(m) },
    getKey: async (name) => input.keys?.[name] ?? null,
    callApp: async () => {
      throw new Error("not used");
    },
    callServiceHelper: async () => {
      throw new Error("not used");
    },
    db: input.db,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    publicUrl: input.publicUrl === undefined ? "https://bridge.example.com" : input.publicUrl,
    workspace: (input.workspace === undefined ? (input.ws ?? "ws_TEST") : input.workspace) as never,
    scopes: scopesStub,
    secrets: secretsFor(input.db),
    receipts,
  };
}

export type Route = (req: { method: string; url: URL; body: unknown; headers: Headers }) => { status?: number; body: unknown };

/** Fake upstream: routes keyed by "METHOD path" (path without query). Records calls. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body: unknown; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body, headers });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const out = route({ method, url, body, headers });
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

/** A handler as the SDK runs it: plain function or `{ run }` spec. */
export function handlerOf(app: { handlers: Record<string, unknown> }, name: string): (input: Json, ctx: SdkOpContext) => Promise<Json> {
  const h = app.handlers[name] as ((i: Json, c: SdkOpContext) => Promise<Json>) | { run: (i: Json, c: SdkOpContext) => Promise<Json> } | undefined;
  if (!h) throw new Error(`no handler ${name}`);
  return typeof h === "function" ? h : h.run;
}
