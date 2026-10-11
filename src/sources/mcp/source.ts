/**
 * Custom / third-party remote MCP servers (harvest: v1 custom-mcp.ts, mcp-url-policy.ts; HARVEST §B).
 * One account = one server URL (https, public address) + optional auth headers, all sealed in Connect.
 * Each server is its own service (`mcp_<host>_<hash>`), its tools classified by MCP annotations, then name.
 * No stdio servers (Connect never starts local processes). MCP OAuth follows once the bridge public URL reaches apps.
 */
import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";

import type { Account, AccountStore } from "../../accounts.ts";
import { classifyMcpTool } from "../../effect.ts";
import { entrySchema, type ToolRegistry, toolName } from "../../tools.ts";
import type { FetchLike } from "../../util/http.ts";
import { sha256Hex } from "../../util/ids.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { McpClient, McpError } from "./client.ts";

export const MAX_HEADERS = 10;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
const RESERVED = new Set([
  "accept", "connection", "content-length", "content-type", "host", "keep-alive", "mcp-protocol-version", "mcp-session-id",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie",
]);

export function validateHeaders(headers: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) throw new McpError("mcp_headers_invalid", `At most ${MAX_HEADERS} headers.`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || RESERVED.has(name.toLowerCase())) throw new McpError("mcp_headers_invalid", `Header ${name} is not allowed.`);
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new McpError("mcp_headers_invalid", `Header ${name} has an invalid value.`);
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Service id for a server URL: readable host stem + 8 hex of the full URL (≤ 32 chars). */
export function mcpService(url: URL): string {
  const stem = url.hostname.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 18);
  return `mcp_${stem}_${sha256Hex(url.toString()).slice(0, 8)}`;
}

export interface McpDeps {
  accounts: AccountStore;
  tools: ToolRegistry;
  secrets: AppSecrets;
  fetchImpl?: FetchLike;
  lookup?: Lookup;
  allowOrigins?: readonly string[];
}

export class McpSource {
  readonly #d: McpDeps;

  constructor(deps: McpDeps) {
    this.#d = deps;
  }

  async #checkedUrl(value: string): Promise<URL> {
    const url = await assertEndpointAllowed(value.trim(), {
      schemes: ["https:"],
      ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
      ...(this.#d.allowOrigins ? { allowOrigins: this.#d.allowOrigins } : {}),
    });
    if (url.search || url.hash) throw new McpError("mcp_url_invalid", "The server address must not contain a query or fragment (put keys in headers).");
    return url;
  }

  async #headers(account: Account): Promise<Record<string, string>> {
    const raw = await this.#d.secrets.get(`account:${account.id}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  async #client(url: string, headers: Record<string, string>): Promise<McpClient> {
    await this.#checkedUrl(url);
    return McpClient.connect({ url, headers, ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}) });
  }

  /** Connect a server: check the URL, list tools with the given headers (proves access), store, register tools. */
  async connect(input: { label: string; url: string; headers?: Record<string, unknown>; kind: "as_me" | "as_itself"; ownerAgent?: string | null }): Promise<Account> {
    const url = await this.#checkedUrl(input.url);
    const headers = validateHeaders(input.headers ?? {});
    const client = await this.#client(url.toString(), headers);
    let tools: Awaited<ReturnType<McpClient["listTools"]>>;
    try {
      tools = await client.listTools();
    } finally {
      await client.close();
    }
    const service = mcpService(url);
    const account = this.#d.accounts.create({
      service,
      source: "mcp",
      kind: input.kind,
      label: input.label,
      ownerAgent: input.ownerAgent ?? null,
      externalRef: url.toString(),
      status: "connected",
    });
    await this.#d.secrets.put(`account:${account.id}`, JSON.stringify(headers));
    this.#register(service, tools);
    return account;
  }

  #register(service: string, tools: Awaited<ReturnType<McpClient["listTools"]>>): number {
    return this.#d.tools.replaceService(
      "mcp",
      service,
      tools.map((t) => ({
        name: toolName(`${service}_${t.name}`),
        upstream: t.name,
        title: (t.title ?? t.name).slice(0, 200),
        description: t.description ?? t.name,
        inputSchema: entrySchema(t.inputSchema),
        ...classifyMcpTool(t.name, t.annotations),
      })),
    );
  }

  async syncTools(account: Account): Promise<number> {
    if (!account.externalRef) throw new McpError("account_not_connected", "This account is not connected.");
    const client = await this.#client(account.externalRef, await this.#headers(account));
    try {
      return this.#register(account.service, await client.listTools());
    } finally {
      await client.close();
    }
  }

  async execute(account: Account, upstreamTool: string, args: Record<string, unknown>): Promise<unknown> {
    if (account.source !== "mcp" || account.status !== "connected" || !account.externalRef) throw new McpError("account_not_connected", "This account is not connected.");
    const client = await this.#client(account.externalRef, await this.#headers(account));
    try {
      const result = await client.callTool(upstreamTool, args);
      if (result.isError) throw new McpError("mcp_tool_error", JSON.stringify(result.content).slice(0, 500));
      return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
    } finally {
      await client.close();
    }
  }

  async disconnect(account: Account): Promise<Account> {
    await this.#d.secrets.delete(`account:${account.id}`);
    const revoked = this.#d.accounts.update(account.id, { status: "revoked", detail: "Disconnected by the owner." });
    if (this.#d.accounts.list({ service: account.service, status: "connected" }).length === 0) this.#d.tools.removeService("mcp", account.service);
    return revoked;
  }
}
