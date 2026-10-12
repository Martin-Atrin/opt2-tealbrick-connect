/**
 * Composio lane: connect an account (hosted link + verified callback), sync the toolkit's tools into the registry,
 * execute a tool for one account, disconnect. Composio holds the OAuth material; Connect stores only the
 * connected account id. Composio `user_id` = the workspace id (DECISION-LOG C12).
 */

import { randomBytes } from "node:crypto";

import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";
import type { Account, AccountStore, ConnectionKind } from "../../accounts.ts";
import { entrySchema, type ToolRegistry, toolName } from "../../tools.ts";
import { randomToken, sha256Hex } from "../../util/ids.ts";
import { type ComposioClient, ComposioError, type ComposioToolkit, OWNER_CONFIGURED_SCHEMES, USER_KEY_SCHEMES } from "./client.ts";
import { type ComposioPolicy, classifyComposioTool } from "./policy.ts";

export const STATE_TTL_MS = 30 * 60 * 1000;
/** A pending sign-in older than this is "stale": the next attempt may delete it at Composio (never an ACTIVE one). */
export const STALE_PENDING_MS = 10 * 60 * 1000;
/** Composio refuses a second alias with the same text for one user, so every attempt gets its own suffix. */
const ALIAS_ATTEMPTS = 3;
const ALIAS_LABEL_MAX = 40;
export const START_FAILED_MESSAGE = "That sign-in could not start. Try again.";

/** The Composio alias for one attempt: the person's label plus a short unique suffix. The label field stays ours. */
export function composioAlias(label: string, suffix: string): string {
  return `${label.slice(0, ALIAS_LABEL_MAX).trim()}-${suffix}`;
}

const randomSuffix = (): string => randomBytes(3).toString("hex");

/** How a toolkit can be connected, derived once on the server (harvest: v1 connect-mode.ts). */
export type ConnectMode = "no_auth" | "ready_managed" | "ready_user_key" | "needs_auth_config" | "not_supported";

export function connectMode(toolkit: ComposioToolkit): ConnectMode {
  if (toolkit.noAuth || toolkit.authSchemes.includes("NO_AUTH")) return "no_auth";
  if (toolkit.managedAuthSchemes.length > 0 || toolkit.authSchemes.length === 0) return "ready_managed";
  if (toolkit.authSchemes.some((s) => (USER_KEY_SCHEMES as readonly string[]).includes(s))) return "ready_user_key";
  if (toolkit.authSchemes.some((s) => (OWNER_CONFIGURED_SCHEMES as readonly string[]).includes(s))) return "needs_auth_config";
  return "not_supported";
}

export interface ComposioDeps {
  db: Db;
  accounts: AccountStore;
  tools: ToolRegistry;
  policies: ReadonlyMap<string, ComposioPolicy>;
  /** Built from the current key (app-own > workspace default); throws ComposioError("composio_key_missing") when absent. */
  client(): Promise<ComposioClient>;
  now?: () => number;
  log?: Logger;
  /** Alias suffix source (tests). */
  suffix?: () => string;
}

export class ComposioSource {
  readonly #d: ComposioDeps;

  constructor(deps: ComposioDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Date.now();
  }

  /** Log an upstream failure (code, status, redacted text) for the operator; the person gets the plain message only. */
  #logUpstream(op: string, error: unknown): void {
    if (!(error instanceof ComposioError)) return;
    this.#d.log?.warn("composio upstream error", {
      op,
      code: error.code,
      upstreamCode: error.upstream?.code ?? null,
      upstreamStatus: error.upstream?.status ?? null,
      detail: error.upstream?.detail ?? error.message,
    });
  }

  /**
   * Before a new attempt: delete OUR OWN stale sign-ins for this toolkit at Composio. Only Connect's own pending
   * rows (never ACTIVE upstream, never a row Connect did not create), only older than STALE_PENDING_MS.
   * Best effort: a failure is logged and never blocks the new attempt.
   */
  async #cleanupStale(client: ComposioClient, service: string, workspaceId: string): Promise<void> {
    const cutoff = this.#now() - STALE_PENDING_MS;
    const stale = this.#d.accounts
      .list({ service, status: "pending" })
      .filter((a) => a.source === "composio" && a.externalRef !== null && a.createdAt <= cutoff);
    for (const account of stale) {
      const ref = account.externalRef as string;
      try {
        const upstream = await client.getConnectedAccount(ref).catch((error: unknown) => {
          if (error instanceof ComposioError && error.code === "composio_not_found") return null;
          throw error;
        });
        if (upstream !== null) {
          const foreign =
            (upstream.userId !== null && upstream.userId !== workspaceId) || (upstream.toolkit !== null && upstream.toolkit !== service);
          if (upstream.status === "ACTIVE" || foreign) {
            this.#d.log?.info("composio stale sign-in kept", { service, account: account.id, ref, status: upstream.status, foreign });
            continue;
          }
          await client.deleteConnectedAccount(ref);
        }
        this.#d.accounts.update(account.id, { status: "failed", detail: "Replaced by a newer sign-in attempt." }, this.#now());
        this.#d.log?.info("composio stale sign-in deleted", { service, account: account.id, ref, upstreamStatus: upstream?.status ?? "gone" });
      } catch (error) {
        this.#d.log?.warn("composio stale sign-in cleanup failed", { service, account: account.id, ref });
        this.#logUpstream("cleanup_stale", error);
      }
    }
  }

  /** Step 1 of "Connect": create a pending account and return Composio's hosted sign-in URL for the popup. */
  async startConnect(input: {
    service: string;
    label: string;
    kind: ConnectionKind;
    ownerAgent?: string | null;
    workspaceId: string;
    callbackUrl: string;
  }): Promise<{ account: Account; redirectUrl: string }> {
    const client = await this.#d.client();
    let toolkit: ComposioToolkit;
    let authConfigId: string;
    try {
      toolkit = await client.getToolkit(input.service);
      const mode = connectMode(toolkit);
      if (mode === "no_auth") throw new ComposioError("composio_toolkit_no_auth", `${toolkit.name} needs no sign-in.`, 409);
      if (mode === "not_supported") throw new ComposioError("composio_toolkit_not_supported", `${toolkit.name} cannot be connected through Composio yet.`, 409);
      authConfigId = await client.getOrCreateAuthConfig(toolkit);
    } catch (error) {
      this.#logUpstream("start_connect", error);
      throw this.#plainStartError(error);
    }
    await this.#cleanupStale(client, toolkit.slug, input.workspaceId);
    const account = this.#d.accounts.create({
      service: toolkit.slug,
      source: "composio",
      kind: input.kind,
      label: input.label,
      ownerAgent: input.ownerAgent ?? null,
      authConfigId,
      now: this.#now(),
    });
    const state = randomToken();
    this.#d.db
      .prepare("INSERT INTO connect_states (state_hash, account_id, purpose, expires_at) VALUES (?, ?, 'composio', ?)")
      .run(sha256Hex(state), account.id, this.#now() + STATE_TTL_MS);
    const callback = new URL(input.callbackUrl);
    callback.searchParams.set("state", state);
    try {
      let link: { connectedAccountId: string | null; redirectUrl: string } | null = null;
      for (let attempt = 1; link === null; attempt += 1) {
        try {
          link = await client.createLink({
            authConfigId,
            userId: input.workspaceId,
            alias: composioAlias(account.label, (this.#d.suffix ?? randomSuffix)()),
            callbackUrl: callback.toString(),
            state,
          });
        } catch (error) {
          // A leftover alias at Composio must never block the person: retry with a fresh suffix.
          if (!(error instanceof ComposioError) || error.code !== "composio_alias_in_use" || attempt >= ALIAS_ATTEMPTS) throw error;
          this.#logUpstream("create_link_alias_retry", error);
        }
      }
      const updated = this.#d.accounts.update(account.id, { externalRef: link.connectedAccountId }, this.#now());
      return { account: updated, redirectUrl: link.redirectUrl };
    } catch (error) {
      this.#logUpstream("create_link", error);
      const plain = this.#plainStartError(error);
      this.#d.accounts.update(account.id, { status: "failed", detail: plain.message }, this.#now());
      throw plain;
    }
  }

  /** Upstream failures while starting a sign-in become one plain message; typed owner errors (key, toolkit) stay as they are. */
  #plainStartError(error: unknown): Error {
    if (error instanceof ComposioError && error.upstream && error.code !== "composio_key_rejected") {
      return new ComposioError("composio_connect_start_failed", START_FAILED_MESSAGE, 502);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Public OAuth callback. The state is single use and expires; the connected account is RE-READ from Composio
   * and must be ACTIVE, of this toolkit, this auth config and this workspace user before the account is connected
   * (fixes v1 app.ts:6366-6420, which trusted the redirect query).
   */
  async completeCallback(input: { state: string | null; connectedAccountId: string | null; workspaceId: string }): Promise<Account> {
    if (!input.state) throw new ComposioError("connect_state_invalid", "The sign-in link is missing its state.", 400);
    const stateHash = sha256Hex(input.state);
    const row = this.#d.db.prepare("SELECT * FROM connect_states WHERE state_hash = ? AND purpose = 'composio'").get(stateHash);
    if (!row || row.consumed_at !== null || Number(row.expires_at) < this.#now()) {
      throw new ComposioError("connect_state_invalid", "This sign-in link is unknown, used or expired. Start Connect again.", 400);
    }
    this.#d.db.prepare("UPDATE connect_states SET consumed_at = ? WHERE state_hash = ?").run(this.#now(), stateHash);
    const account = this.#d.accounts.get(String(row.account_id));
    if (account?.status !== "pending") throw new ComposioError("connect_state_invalid", "The pending connection no longer exists.", 400);
    const upstreamId = account.externalRef ?? input.connectedAccountId;
    if (!upstreamId) {
      this.#d.accounts.update(account.id, { status: "failed", detail: "Composio returned no connected account." }, this.#now());
      throw new ComposioError("composio_account_missing", "Composio returned no connected account.", 400);
    }
    if (account.externalRef && input.connectedAccountId && input.connectedAccountId !== account.externalRef) {
      this.#d.accounts.update(account.id, { status: "failed", detail: "Callback named a different connected account." }, this.#now());
      throw new ComposioError("composio_account_mismatch", "The callback named a different connected account.", 400);
    }
    const client = await this.#d.client();
    const upstream = await client.getConnectedAccount(upstreamId).catch((error: unknown) => {
      this.#logUpstream("callback_get_account", error);
      throw error;
    });
    const problems = [
      upstream.status !== "ACTIVE" ? `status ${upstream.status}` : null,
      upstream.toolkit && upstream.toolkit !== account.service ? "toolkit mismatch" : null,
      upstream.userId && upstream.userId !== input.workspaceId ? "workspace mismatch" : null,
      upstream.authConfigId && account.authConfigId && upstream.authConfigId !== account.authConfigId ? "auth config mismatch" : null,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0) {
      this.#d.accounts.update(account.id, { status: "failed", detail: `Composio account not usable: ${problems.join(", ")}.` }, this.#now());
      throw new ComposioError("composio_account_not_active", `The connection did not complete (${problems.join(", ")}).`, 409);
    }
    const connected = this.#d.accounts.update(account.id, { status: "connected", detail: "", externalRef: upstream.id }, this.#now());
    if (this.#d.tools.countFor(connected.service) === 0) await this.syncTools(connected.service);
    return connected;
  }

  /** Load the toolkit's tools, classify each with the policy (or name inference), replace the registry rows. */
  async syncTools(service: string): Promise<number> {
    const client = await this.#d.client();
    const tools = await client.listTools(service).catch((error: unknown) => {
      this.#logUpstream("sync_tools", error);
      throw error;
    });
    const policy = this.#d.policies.get(service);
    return this.#d.tools.replaceService(
      "composio",
      service,
      tools.map((tool) => ({
        name: toolName(tool.slug),
        upstream: tool.slug,
        title: tool.name,
        description: tool.description,
        inputSchema: entrySchema(tool.inputParameters),
        ...classifyComposioTool(tool.slug, policy),
      })),
      this.#now(),
    );
  }

  async execute(account: Account, upstreamSlug: string, args: Record<string, unknown>, workspaceId: string): Promise<unknown> {
    if (account.source !== "composio" || account.status !== "connected" || !account.externalRef) {
      throw new ComposioError("account_not_connected", "This account is not connected.", 409);
    }
    const client = await this.#d.client();
    const result = await client
      .executeTool({ slug: upstreamSlug, userId: workspaceId, connectedAccountId: account.externalRef, arguments: args })
      .catch((error: unknown) => {
        this.#logUpstream("execute", error);
        throw error;
      });
    if (!result.successful) throw new ComposioError("composio_tool_failed", result.error ?? "The tool call failed.", 502);
    return result.data;
  }

  /** Remove the upstream connection (best effort), mark revoked, drop the toolkit's tools when no account is left. */
  async disconnect(account: Account): Promise<Account> {
    if (account.externalRef) {
      try {
        await (await this.#d.client()).deleteConnectedAccount(account.externalRef);
      } catch (error) {
        if (!(error instanceof ComposioError) || error.code !== "composio_not_found") throw error;
      }
    }
    const revoked = this.#d.accounts.update(account.id, { status: "revoked", detail: "Disconnected by the owner." }, this.#now());
    if (this.#d.accounts.list({ service: account.service, status: "connected" }).length === 0) {
      this.#d.tools.removeService("composio", account.service);
    }
    return revoked;
  }
}
