/**
 * Connected accounts (scope type `account`). Several accounts per service; each account is one scope instance,
 * and every agent gets its own access level per account through the SDK scope store (`tb.scopes_set`).
 * Kind: `as_me` (the owner's account) or `as_itself` (the agent's own identity, `owner_agent` set).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { newId } from "./util/ids.ts";

export const ACCOUNT_SOURCES = ["composio", "catalog", "mcp", "channel"] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];
export const CONNECTION_KINDS = ["as_me", "as_itself"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const ACCOUNT_STATUSES = ["pending", "connected", "failed", "revoked"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface Account {
  id: string;
  service: string;
  source: AccountSource;
  kind: ConnectionKind;
  label: string;
  ownerAgent: string | null;
  externalRef: string | null;
  authConfigId: string | null;
  status: AccountStatus;
  detail: string;
  createdAt: number;
  updatedAt: number;
}

export const LABEL_MAX = 60;

export function normalizeLabel(label: string): string {
  // Control and bidi characters are stripped: the label reaches the canvas summary and other agents' tool output.
  const clean = label.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, LABEL_MAX);
  if (!clean) throw new Error("label_required");
  return clean;
}

function fromRow(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    service: String(row.service),
    source: String(row.source) as AccountSource,
    kind: String(row.kind) as ConnectionKind,
    label: String(row.label),
    ownerAgent: row.owner_agent === null ? null : String(row.owner_agent),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    authConfigId: row.auth_config_id === null ? null : String(row.auth_config_id),
    status: String(row.status) as AccountStatus,
    detail: String(row.detail),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class AccountStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: {
    service: string;
    source: AccountSource;
    kind: ConnectionKind;
    label: string;
    ownerAgent?: string | null;
    externalRef?: string | null;
    authConfigId?: string | null;
    status?: AccountStatus;
    now?: number;
  }): Account {
    if (input.kind === "as_itself" && !input.ownerAgent) throw new Error("owner_agent_required");
    if (input.kind === "as_me" && input.ownerAgent) throw new Error("owner_agent_not_allowed");
    const now = input.now ?? Date.now();
    const id = newId("cna");
    this.#db
      .prepare(
        `INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, external_ref, auth_config_id, status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(
        id,
        input.service,
        input.source,
        input.kind,
        normalizeLabel(input.label),
        input.ownerAgent ?? null,
        input.externalRef ?? null,
        input.authConfigId ?? null,
        input.status ?? "pending",
        now,
        now,
      );
    const created = this.get(id);
    if (!created) throw new Error("account_create_failed");
    return created;
  }

  get(id: string): Account | null {
    const row = this.#db.prepare("SELECT * FROM connect_accounts WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  list(filter: { service?: string; status?: AccountStatus } = {}): Account[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.service) {
      where.push("service = ?");
      params.push(filter.service);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql = `SELECT * FROM connect_accounts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY service, label, created_at`;
    return this.#db.prepare(sql).all(...params).map(fromRow);
  }

  /** Services with at least one connected account: the only services whose tools are offered to agents. */
  connectedServices(): string[] {
    return this.#db
      .prepare("SELECT DISTINCT service FROM connect_accounts WHERE status = 'connected' ORDER BY service")
      .all()
      .map((row) => String(row.service));
  }

  update(id: string, patch: Partial<Pick<Account, "label" | "status" | "detail" | "externalRef" | "authConfigId">>, now = Date.now()): Account {
    const current = this.get(id);
    if (!current) throw new Error("account_not_found");
    const next = { ...current, ...patch, label: patch.label === undefined ? current.label : normalizeLabel(patch.label) };
    this.#db
      .prepare(
        "UPDATE connect_accounts SET label = ?, status = ?, detail = ?, external_ref = ?, auth_config_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.label, next.status, next.detail.slice(0, 500), next.externalRef, next.authConfigId, now, id);
    return { ...next, updatedAt: now };
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM connect_accounts WHERE id = ?").run(id);
  }
}
