/**
 * Tool registry behind the dynamic `tools` operation (MANIFEST §5.3, mode "search").
 * One row per third-party tool; the bridge reads it through the SDK bridge ops catalog / resolve.
 * Only tools of services with at least one connected account are offered (search filters on that).
 */
import type { CrudAction, DynamicCatalogEntry, DynamicResolution, Effect, HoldFamily, JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import type { ToolClass } from "./effect.ts";
import { sha256Hex } from "./util/ids.ts";

export const TOOL_SOURCES = ["composio", "catalog", "mcp"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

/** Argument every catalog entry carries so the agent can pick one of several accounts of the same service. */
export const ACCOUNT_ARGUMENT = "connect_account";
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/u;
const SCHEMA_MAX_BYTES = 16_384;

export interface ToolRow extends ToolClass {
  name: string;
  source: ToolSource;
  service: string;
  upstream: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** DynamicCatalogEntry.name from an upstream slug: lower snake case, ≤ 48 chars (hash suffix when shortened). */
export function toolName(upstream: string): string {
  let name = upstream.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!/^[a-z]/u.test(name)) name = `t_${name}`;
  if (name.length > 48) name = `${name.slice(0, 39)}_${sha256Hex(upstream).slice(0, 8)}`;
  if (!NAME_PATTERN.test(name)) throw new Error(`tool_name_invalid: ${upstream}`);
  return name;
}

/** The tool's own schema plus the optional account selector; oversized schemas collapse to an open object. */
export function entrySchema(upstreamSchema: unknown): JsonSchemaObject {
  const base = (upstreamSchema && typeof upstreamSchema === "object" ? upstreamSchema : {}) as Record<string, unknown>;
  const properties = (base.properties && typeof base.properties === "object" ? base.properties : {}) as Record<string, unknown>;
  const accountProperty = {
    type: "string",
    description: "Connected account id or label. Optional when you have exactly one account for this service.",
  };
  let schema: JsonSchemaObject = {
    ...base,
    type: "object",
    properties: { ...properties, [ACCOUNT_ARGUMENT]: accountProperty },
  };
  delete (schema as Record<string, unknown>).$schema;
  delete (schema as Record<string, unknown>).$id;
  if (Buffer.byteLength(JSON.stringify(schema)) > SCHEMA_MAX_BYTES) {
    schema = {
      type: "object",
      description: "Large input schema: pass the upstream arguments as documented by the service.",
      properties: { [ACCOUNT_ARGUMENT]: accountProperty },
      additionalProperties: true,
    };
  }
  return schema;
}

function fromRow(row: Record<string, unknown>): ToolRow {
  return {
    name: String(row.name),
    source: String(row.source) as ToolSource,
    service: String(row.service),
    upstream: String(row.upstream),
    title: String(row.title),
    description: String(row.description),
    inputSchema: JSON.parse(String(row.input_schema)) as JsonSchemaObject,
    crud: JSON.parse(String(row.crud)) as CrudAction[],
    effect: String(row.effect) as Effect,
    ...(row.hold_family ? { holdFamily: String(row.hold_family) as HoldFamily } : {}),
  };
}

export function toEntry(row: ToolRow): DynamicCatalogEntry {
  return {
    name: row.name,
    title: row.title.slice(0, 200),
    description: `[${row.service}] ${row.description}`.slice(0, 1000),
    inputSchema: row.inputSchema,
    crud: row.crud,
    effect: row.effect,
    ...(row.holdFamily ? { holdFamily: row.holdFamily } : {}),
  };
}

export class ToolRegistry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Replace every tool of one (source, service) in one transaction. */
  replaceService(source: ToolSource, service: string, tools: readonly Omit<ToolRow, "source" | "service">[], now = Date.now()): number {
    return this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM connect_tools WHERE source = ? AND service = ?").run(source, service);
      const insert = this.#db.prepare(
        `INSERT INTO connect_tools (name, source, service, upstream, title, description, input_schema, crud, effect, hold_family, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, service = excluded.service, upstream = excluded.upstream,
           title = excluded.title, description = excluded.description, input_schema = excluded.input_schema, crud = excluded.crud,
           effect = excluded.effect, hold_family = excluded.hold_family, updated_at = excluded.updated_at`,
      );
      for (const tool of tools) {
        insert.run(
          tool.name, source, service, tool.upstream, tool.title, tool.description, JSON.stringify(tool.inputSchema),
          JSON.stringify(tool.crud), tool.effect, tool.holdFamily ?? null, now,
        );
      }
      return tools.length;
    });
  }

  removeService(source: ToolSource, service: string): void {
    this.#db.prepare("DELETE FROM connect_tools WHERE source = ? AND service = ?").run(source, service);
  }

  countFor(service: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM connect_tools WHERE service = ?").get(service);
    return Number(row?.n ?? 0);
  }

  get(name: string): ToolRow | null {
    const row = this.#db.prepare("SELECT * FROM connect_tools WHERE name = ?").get(name);
    return row ? fromRow(row) : null;
  }

  resolve(name: string): DynamicResolution | null {
    const row = this.get(name);
    if (!row) return null;
    return { tool: row.name, crud: row.crud, effect: row.effect, ...(row.holdFamily ? { holdFamily: row.holdFamily } : {}) };
  }

  /**
   * Search tools of the given services. Every query word must appear in name, title, description or service;
   * results ordered by how many words hit the name/service first. Empty query lists the first `limit` tools.
   */
  search(query: string, services: readonly string[], limit = 20): DynamicCatalogEntry[] {
    if (services.length === 0) return [];
    const words = query.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w.length > 1).slice(0, 8);
    const placeholders = services.map(() => "?").join(", ");
    const where = [`service IN (${placeholders})`];
    const params: unknown[] = [...services];
    for (const word of words) {
      where.push("(lower(name) LIKE ? OR lower(title) LIKE ? OR lower(description) LIKE ? OR lower(service) LIKE ?)");
      const like = `%${word}%`;
      params.push(like, like, like, like);
    }
    const rows = this.#db
      .prepare(`SELECT * FROM connect_tools WHERE ${where.join(" AND ")} ORDER BY service, name LIMIT 500`)
      .all(...params)
      .map(fromRow);
    const score = (row: ToolRow) => words.filter((w) => row.name.includes(w) || row.service.includes(w)).length;
    return rows
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(toEntry);
  }
}
